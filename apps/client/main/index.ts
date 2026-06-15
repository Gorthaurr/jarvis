/**
 * Bootstrap main-процесса Electron (§3).
 *
 * Поднимает окно (renderer), инициализирует транспорт (WS к серверу), tier0, актуаторы,
 * аудио-координацию (стаб) и связывает всё через IPC-мост (preload).
 *
 * M0-поток (§17):
 *   пользователь вводит текст в поле renderer
 *     -> main сначала пробует tier0 ЛОКАЛЬНО (regex, $0)
 *     -> если tier0 распознал command -> исполняет dispatch(actuators) локально
 *     -> если tier0 не распознал -> шлёт dev.text на сервер
 *        -> сервер вернёт action.command (напр. app.launch)
 *        -> transport исполнит через actuators -> вернёт action.result
 *     -> состояние (idle/thinking/...) прокидывается в renderer (орб).
 */
import { app, BrowserWindow, Menu, ipcMain, session } from "electron";
import { join } from "node:path";
import { createLogger, envInt, env as readEnv } from "@jarvis/shared";
import type { ClientState, TaskControl, DemoEvent, SkillSaved, SkillStep } from "@jarvis/protocol";

import { existsSync } from "node:fs";
import { Transport } from "./transport/index.js";
import { dispatch } from "./actuators/index.js";
import * as tier0 from "./tier0/index.js";
import { AudioCoordinator } from "./audio/index.js";
import { sidecar } from "./actuators/sidecar-client.js";
import { browserController } from "./actuators/browser-cdp.js";
import { buildSystemProfile, formatProfileSummary } from "./sensors/system-profiler.js";
import { runSkill } from "./skill-runner/index.js";
import { createClientActuator } from "./skill-runner/client-actuator.js";
import { IPC } from "./ipc-contract.js";
import type { ConfirmResultPayload, SkillRecState } from "./ipc-contract.js";

const log = createLogger("main");

// §10: Джарвис говорит сам (онбординг/проактивность) без жеста пользователя.
// Без этого Chromium держит AudioContext в suspended — голос молчит.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Сборка main идёт в CommonJS (esbuild format=cjs), поэтому __dirname доступен нативно
// и указывает на dist/main. Пути к preload/renderer строим относительно него.

let win: BrowserWindow | null = null;
let transport: Transport | null = null;
let audio: AudioCoordinator | null = null;
let audioSeq = 0;
/** Текущее состояние связи — чтобы переслать его, когда renderer догрузится (race-fix). */
let linkOnline = false;

// ── запись/повтор навыков демонстрацией (§8) ───────────────────
/** Активная сессия записи навыка: имя + накопленные UIA-события из sidecar-хука. */
let skillRec: { name: string; events: DemoEvent[] } | null = null;
/** Реестр доступных навыков (id → шаги/версия/имя) — для повтора без сервера. */
const skillRegistry = new Map<string, { name: string; version: number; steps: SkillStep[] }>();

/** Прокинуть состояние записи навыка в renderer (§8). */
function sendSkillState(s: SkillRecState): void {
  win?.webContents.send(IPC.skillState, s);
}

/** Конфиг подключения из env (см. .env.example). На M0 — дефолты localhost:8787. */
function transportConfig() {
  return {
    host: readEnv("HOST", "127.0.0.1"),
    port: envInt("PORT", 8787),
    token: readEnv("JARVIS_CLIENT_TOKEN", "dev-token"), // dev-токен; сервер валидирует позже
    clientVersion: app.getVersion?.() ?? "0.1.0",
  };
}

/** Прокинуть состояние клиента в renderer (орб) и серверу. */
function setState(state: ClientState): void {
  win?.webContents.send(IPC.state, state);
  transport?.sendClientState(state);
}

function createWindow(): void {
  // Убрать дефолтное меню Electron (File/Edit/View/…) — обычное десктоп-приложение.
  Menu.setApplicationMenu(null);

  // §3 КРИТИЧНО для слуха: Electron по умолчанию ОТКЛОНЯЕТ запрос media от renderer,
  // из-за чего getUserMedia падал (ошибка глоталась) и Джарвис «не слышал». Явно
  // разрешаем аудио-захват. (OS-уровень Windows: Параметры → Конфиденциальность →
  // Микрофон → разрешить классическим приложениям — должно быть включено.)
  const allowMic = (p: string): boolean =>
    p === "media" || p === "audioCapture" || p === "microphone";
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMic(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMic(permission));

  win = new BrowserWindow({
    width: 420,
    height: 640,
    title: "Jarvis",
    backgroundColor: "#0b0d12",
    autoHideMenuBar: true,
    webPreferences: {
      // §3: renderer изолирован; node-доступа нет, только мост preload.
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload использует require('electron') — sandbox=false для contextBridge-моста
      devTools: process.env.JARVIS_DEVTOOLS === "1",
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  win.loadFile(join(__dirname, "../renderer/index.html"));
  win.on("closed", () => {
    win = null;
  });

  // Диагностика: проброс консоли рендерера в лог main (иначе ошибки/логи renderer
  // не видны нигде). Сигнатура console-message менялась между версиями Electron —
  // вытаскиваем message устойчиво. Уровни warn/error помечаем.
  win.webContents.on("console-message", (...a: unknown[]) => {
    const msg = a.find((x): x is string => typeof x === "string") ?? (a[0] as { message?: string })?.message;
    if (msg) log.info(`[renderer] ${String(msg).slice(0, 400)}`);
  });

  // Race-fix: renderer подписывается на события только после загрузки. Состояние связи
  // могло прийти раньше (потеряно) — пересылаем актуальное, когда DOM/скрипт готовы.
  win.webContents.on("did-finish-load", () => {
    win?.webContents.send(IPC.link, { online: linkOnline });
  });

  // DevTools НЕ открываем автоматически. Только по явному флагу JARVIS_DEVTOOLS=1.
  if (process.env.JARVIS_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "detach" });
}

/** Поднять транспорт и связать его события с renderer-IPC. */
function startTransport(): void {
  transport = new Transport(transportConfig(), dispatch);

  // Аудио-координатор (§3): гейтит стрим, прокидывает кадры/VAD на сервер,
  // воспроизведение и barge-in — в renderer.
  audio = new AudioCoordinator({
    sendFrame: (pcm) => transport?.sendAudioFrame(pcm, 16_000, audioSeq++),
    sendVad: (state) => transport?.sendVad(state),
    onMicState: (open) => win?.webContents.send(IPC.micState, open),
    onBargeIn: () => win?.webContents.send(IPC.bargeIn),
  });

  // speak.chunk (TTS) → renderer для воспроизведения; client.state → орб + аудио-гейт.
  transport.on("speak", (c) => {
    if (c.last) log.info("speak.chunk → renderer (last)");
    win?.webContents.send(IPC.speakChunk, c);
  });
  transport.on("serverState", (s) => {
    win?.webContents.send(IPC.state, s);
    audio?.setServerState(s);
  });

  transport.on("connected", (hello) => {
    log.info(`подключено к серверу: session=${hello.sessionId}`);
    linkOnline = true;
    win?.webContents.send(IPC.link, { online: true });
    setState("idle");
    void sendEnvProfile(); // §9: отдать агенту авто-профиль окружения (браузер/приложения)
  });
  transport.on("link", (l) => {
    linkOnline = l.online;
    win?.webContents.send(IPC.link, l);
  });
  transport.on("disconnected", () => {
    linkOnline = false;
    win?.webContents.send(IPC.link, { online: false });
  });

  transport.on("transcript", (t) => win?.webContents.send(IPC.transcript, t));
  transport.on("nudge", (n) => win?.webContents.send(IPC.nudge, n));
  transport.on("confirmRequest", (r) => win?.webContents.send(IPC.confirmRequest, r));
  transport.on("display", (c) => win?.webContents.send(IPC.display, c));
  transport.on("taskStatus", (s) => win?.webContents.send(IPC.taskStatus, s));
  // Навык записан/прислан сервером (§8): кладём в реестр для повтора + показываем в UI.
  transport.on("skillSaved", (s: SkillSaved) => {
    skillRegistry.set(s.id, { name: s.name, version: s.version, steps: s.steps });
    win?.webContents.send(IPC.skillSaved, s);
  });
  transport.on("protocolError", (e) => {
    // version_mismatch -> «требуется обновление»: показываем карточкой в renderer (§5).
    win?.webContents.send(IPC.display, {
      title: e.code === "version_mismatch" ? "Требуется обновление" : "Ошибка",
      markdown: e.message,
    });
    setState("idle");
  });

  transport.start();
}

/** Обработка dev-текста из renderer: сначала tier0 локально, иначе на сервер (§3, §17). */
async function handleSubmitText(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  log.info(`ввод пользователя: "${trimmed}"`);
  setState("thinking");

  // 1) tier0 — локальный детерминированный путь, $0, без сети (§3).
  const match = tier0.parse(trimmed);
  if (match) {
    try {
      if (match.kind === "command") {
        // Исполняем через тот же актуаторный диспатч, что и серверные команды.
        const result = await dispatch(`tier0-${Date.now().toString(36)}`, match.command);
        log.info(`tier0 command "${match.utterance}" -> ok=${result.ok}`);
        win?.webContents.send(IPC.display, {
          title: "tier0 (локально, $0)",
          markdown: result.ok
            ? `Выполнено: \`${match.command.kind}\``
            : `Ошибка: ${result.error?.message ?? "unknown"}`,
        });
      } else {
        await match.run();
        log.info(`tier0 local "${match.label}" выполнено`);
        win?.webContents.send(IPC.display, {
          title: "tier0 (локально, $0)",
          markdown: `Выполнено: ${match.label}`,
        });
      }
    } catch (e) {
      log.error(`tier0 ошибка: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setState("idle");
    }
    return;
  }

  // 2) Не tier0 -> на сервер (он вернёт action.command, transport исполнит актуатором).
  if (transport) {
    transport.sendDevText(trimmed);
    // state вернётся в idle по приходу результата/transcript; здесь оставляем thinking.
  } else {
    log.warn("transport не инициализирован — нет соединения с сервером");
    setState("idle");
  }
}

// ── запись навыка демонстрацией (§8) ───────────────────────────

/** Начать запись: поднять UIA-хук в sidecar; копить события до «Готово». */
async function startSkillRecording(name: string): Promise<void> {
  const sc = sidecar();
  if (!sc.ready) {
    log.warn("запись навыка невозможна — sidecar не готов");
    sendSkillState({ recording: false, count: 0, unavailable: true });
    return;
  }
  try {
    await sc.startDemo();
    skillRec = { name: name.trim() || "Навык", events: [] };
    log.info(`запись навыка начата: «${skillRec.name}»`);
    sendSkillState({ recording: true, count: 0 });
  } catch (e) {
    log.warn(`не удалось начать запись навыка: ${e instanceof Error ? e.message : String(e)}`);
    sendSkillState({ recording: false, count: 0, unavailable: true });
  }
}

/** Завершить запись: забрать авторитетный батч из sidecar и отправить на сервер (§8). */
async function stopSkillRecording(): Promise<void> {
  const rec = skillRec;
  skillRec = null;
  if (!rec) return;
  let events = rec.events;
  try {
    const res = await sidecar().stopDemo();
    if (Array.isArray(res?.events) && res.events.length > 0) {
      events = res.events.map((e) => ({
        role: String(e.role ?? ""),
        name: e.name ? String(e.name) : undefined,
        action: String(e.action ?? "invoke"),
        ts: Number(e.ts ?? 0),
      }));
    }
  } catch (e) {
    log.warn(`stopDemo вернул ошибку, используем накопленный поток: ${e instanceof Error ? e.message : String(e)}`);
  }
  sendSkillState({ recording: false, count: events.length });
  if (events.length === 0) {
    win?.webContents.send(IPC.display, {
      title: "Навык не записан",
      markdown: "Я не уловил действий. Попробуйте показать ещё раз — кликайте по элементам, а не по пустому месту.",
    });
    return;
  }
  log.info(`запись навыка «${rec.name}» завершена: ${events.length} событий → на сервер`);
  transport?.sendDemoSave(rec.name, events);
}

/** Отменить запись без сохранения (§8). */
async function cancelSkillRecording(): Promise<void> {
  skillRec = null;
  try {
    await sidecar().stopDemo();
  } catch {
    /* sidecar мог не записывать — игнор */
  }
  sendSkillState({ recording: false, count: 0 });
  log.info("запись навыка отменена");
}

/** Повторить ранее записанный навык по id — локальный skill-runner поверх sidecar (§8). */
async function runSavedSkill(id: string): Promise<void> {
  const skill = skillRegistry.get(id);
  if (!skill) {
    log.warn(`повтор навыка ${id}: нет в реестре`);
    win?.webContents.send(IPC.display, { title: "Навык не найден", markdown: `Навык «${id}» не записан в этой сессии.` });
    return;
  }
  log.info(`повтор навыка «${skill.name}» (${id}): ${skill.steps.length} шагов`);
  win?.webContents.send(IPC.display, { title: `Повторяю: ${skill.name}`, markdown: `${skill.steps.length} шагов…` });
  setState("thinking");
  try {
    const outcome = await runSkill({
      skillId: id,
      version: skill.version,
      steps: skill.steps,
      cancel: { cancelled: false },
      actuator: createClientActuator(),
    });
    win?.webContents.send(IPC.display, {
      title: outcome.ok ? `Готово: ${skill.name}` : `Сбой: ${skill.name}`,
      markdown: outcome.ok ? "Навык выполнен." : `Не получилось: ${outcome.message ?? "ошибка"}.`,
    });
  } catch (e) {
    log.error(`повтор навыка упал: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    setState("idle");
  }
}

/** Регистрация IPC-обработчиков renderer -> main. */
function registerIpc(): void {
  ipcMain.on(IPC.submitText, (_e, text: string) => void handleSubmitText(text));
  ipcMain.on(IPC.confirmResult, (_e, payload: ConfirmResultPayload) => {
    transport?.sendConfirmResult(payload.requestId, payload.approved, payload.revision);
  });
  // Управление задачей из UI (§20): «стоп»/«пауза»/«продолжить» -> task.control на сервер.
  ipcMain.on(IPC.taskControl, (_e, p: TaskControl) => {
    transport?.sendTaskControl(p.action, p.taskId);
  });
  // Аудио из renderer (§3): кадры захвата + управление микрофоном.
  ipcMain.on(IPC.pushPcm, (_e, buf: ArrayBuffer) => audio?.ingest(new Int16Array(buf)));
  ipcMain.on(IPC.activate, () => audio?.activate());
  ipcMain.on(IPC.mute, () => audio?.mute());
  // Запись/повтор навыков демонстрацией (§8).
  ipcMain.on(IPC.skillStart, (_e, name: string) => void startSkillRecording(name));
  ipcMain.on(IPC.skillStop, () => void stopSkillRecording());
  ipcMain.on(IPC.skillCancel, () => void cancelSkillRecording());
  ipcMain.on(IPC.skillRun, (_e, id: string) => void runSavedSkill(id));
}

// ── жизненный цикл приложения ──────────────────────────────────

/** Поднять win-сайдкар (UIA+SendInput, §6), если exe доступен (extraResources). */
// §9: авто-профиль окружения (браузер/приложения) — собираем один раз, шлём агенту при
// каждом подключении (после reconnect тоже — resumed-сессия должна знать окружение).
let envSummary: string | undefined;
async function sendEnvProfile(): Promise<void> {
  try {
    if (envSummary === undefined) {
      const profile = await buildSystemProfile();
      envSummary = formatProfileSummary(profile);
      log.info("окружение определено (авто)", { summary: envSummary });
    }
    if (envSummary) transport?.sendEnv(envSummary);
  } catch (e) {
    log.warn("профиль окружения не собран", e instanceof Error ? e.message : String(e));
  }
}

// §6 user-takeover: дебаунс физического ввода → пауза/возобновление агента на сервере.
// Взял мышь/клаву → сразу takeover(true); по простою TAKEOVER_IDLE_MS — takeover(false).
const TAKEOVER_IDLE_MS = 1500;
let userActive = false;
let userIdleTimer: ReturnType<typeof setTimeout> | undefined;
function noteUserInput(): void {
  if (!userActive) {
    userActive = true;
    transport?.sendTakeover(true); // пользователь взял управление → агент уступает
  }
  if (userIdleTimer) clearTimeout(userIdleTimer);
  userIdleTimer = setTimeout(() => {
    userActive = false;
    transport?.sendTakeover(false); // ввод свободен → агент продолжает
  }, TAKEOVER_IDLE_MS);
}

function startSidecar(): void {
  // В dev C#-сайдкар может быть не собран — тогда ready=false, актуаторы UIA деградируют.
  const candidates = [
    join(process.resourcesPath ?? "", "sidecar-win.exe"),
    join(__dirname, "../../../sidecar-win/bin/Release/net8.0-windows/win-x64/publish/SidecarWin.exe"),
  ];
  const exe = candidates.find((p) => p && existsSync(p));
  if (exe) {
    const sc = sidecar();
    // Push из sidecar: живые UIA-события записи навыка (§8) + user-takeover (§6).
    sc.onPush((msg) => {
      // §6 user-takeover: пользователь физически взялся за мышь/клаву → агент уступает.
      if (msg.event === "user-input") {
        noteUserInput();
        return;
      }
      if (msg.event !== "demo" || !skillRec) return;
      const ev: DemoEvent = {
        role: String(msg.role ?? ""),
        name: msg.name ? String(msg.name) : undefined,
        action: String(msg.action ?? "invoke"),
        ts: Number(msg.ts ?? 0),
      };
      skillRec.events.push(ev);
      sendSkillState({
        recording: true,
        count: skillRec.events.length,
        last: ev.name ? `${ev.role}: ${ev.name}` : ev.role,
      });
    });
    sc.start(exe);
    // §6: включить арбитраж ввода (LL-хуки), чтобы ловить «пользователь взял управление».
    // Сайдкару нужен момент на подъём — подписываемся чуть погодя, best-effort.
    setTimeout(() => {
      sc.request("raw-input.subscribe", { enable: true }).catch(() => {
        log.warn("raw-input.subscribe не удался — user-takeover недоступен");
      });
    }, 2500);
  } else {
    log.warn("win-сайдкар не найден — UIA-актуаторы и запись навыков недоступны (соберите apps/sidecar-win)");
  }
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  startTransport();
  startSidecar();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // На Windows закрытие всех окон завершает приложение.
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  transport?.stop();
  sidecar().stop();
  void browserController().close(); // §6: гасим управляемый браузер (не оставляем висеть)
});
