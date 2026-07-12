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
import { app, BrowserWindow, Menu, ipcMain, powerMonitor, session } from "electron";
import { join } from "node:path";
import { createLogger, envInt, env as readEnv } from "@jarvis/shared";
import type { ClientState, TaskControl, DemoEvent, SkillSaved, SkillStep, ClientSettings } from "@jarvis/protocol";

import { existsSync } from "node:fs";
import { Transport } from "./transport/index.js";
import { dispatch } from "./actuators/index.js";
import * as tier0 from "./tier0/index.js";
import { monitors } from "./monitors.js";
import { startGsiListener } from "./sensors/gsi-listener.js";
import { settingsStore } from "./settings-store.js";
import { identityStore } from "./identity-store.js";
import { AudioCoordinator } from "./audio/index.js";
import { sidecar } from "./actuators/sidecar-client.js";
import { browserController } from "./actuators/browser-cdp.js";
import { buildSystemProfile, formatProfileSummary } from "./sensors/system-profiler.js";
import { captureAmbient } from "./sensors/system-snapshot.js";
import { Sensors } from "./sensors/index.js";
import { runSkill } from "./skill-runner/index.js";
import { createClientActuator } from "./skill-runner/client-actuator.js";
import { IPC } from "./ipc-contract.js";
import type { ConfirmResultPayload, SkillRecState, SettingsPatch } from "./ipc-contract.js";

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
    // §6B/B2: приоритет — явный JARVIS_CLIENT_TOKEN (континьюити power-юзера) → per-install UUID
    // (опт-ин JARVIS_CLIENT_IDENTITY) → дефолт 'dev-token' (→ DEV_USER, существующая установка цела).
    token: readEnv("JARVIS_CLIENT_TOKEN", "") || identityStore.getOrCreateInstallId() || "dev-token",
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
    backgroundColor: "#0a0b0e",
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

  // §6 мультимонитор: окно Джарвиса живёт на его РАБОЧЕМ мониторе (по умолч. НЕосновном), чтобы не
  // мешать на главном экране. «Выведи на основной» (monitor_set → primary) / выбор монитора в
  // настройках (monitor_assign) — двигают окно сюда же через хук relayout.
  const placeWindow = (): void => {
    if (!win) return;
    const { width, height } = win.getBounds();
    const { x, y } = monitors.windowPosition(width, height);
    win.setBounds({ x, y, width, height });
  };
  monitors.setRelayout(placeWindow);
  placeWindow();

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

/** §9 «не мешать»: сенсоры контекста (locked через powerMonitor) → client.context серверу. */
let sensors: Sensors | null = null;
function startSensors(): void {
  if (sensors) return;
  sensors = new Sensors();
  sensors.on("context", (c) => transport?.sendContext(c)); // снимок + изменения → серверу
  // Реальный сигнал блокировки экрана (Windows): powerMonitor шлёт lock/unlock.
  try {
    powerMonitor.on("lock-screen", () => sensors?.setLocked(true));
    powerMonitor.on("unlock-screen", () => sensors?.setLocked(false));
  } catch (e) {
    log.warn("powerMonitor lock-события недоступны", { error: e instanceof Error ? e.message : String(e) });
  }
  sensors.start(15_000); // снимок раз в 15с + сразу при изменении (setLocked)
}

/** Поднять транспорт и связать его события с renderer-IPC. */
function startTransport(): void {
  transport = new Transport(transportConfig(), dispatch);
  startSensors(); // §9: контекст занятости (locked) → серверу для «не мешать»

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
    if (sensors) transport?.sendContext(sensors.snapshot()); // §9: свежий контекст занятости на (ре)коннекте
    void sendEnvProfile(); // §9: отдать агенту авто-профиль окружения (браузер/приложения)
    void sendAmbient(); // §контекст: живой снимок «что открыто и где» сразу на (ре)коннекте
    // §15: досылаем сохранённые язык/контекст серверу (робастно к оффлайн-сейву/реконнекту).
    const snap = settingsStore.snapshot();
    transport?.sendSettings({ language: snap.language, context: snap.context });
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
  transport.on("chat", (m) => win?.webContents.send(IPC.chat, m)); // §22 чат-история
  transport.on("usage", (u) => win?.webContents.send(IPC.usage, u)); // §6B/B5 расход/лимиты → вкладка «Оплата»
  transport.on("nudge", (n) => win?.webContents.send(IPC.nudge, n));
  transport.on("confirmRequest", (r) => win?.webContents.send(IPC.confirmRequest, r));
  transport.on("display", (c) => win?.webContents.send(IPC.display, c));
  transport.on("taskStatus", (s) => win?.webContents.send(IPC.taskStatus, s));
  // Навык записан/прислан сервером (§8): кладём в реестр для повтора + показываем в UI.
  transport.on("skillSaved", (s: SkillSaved) => {
    skillRegistry.set(s.id, { name: s.name, version: s.version, steps: s.steps });
    win?.webContents.send(IPC.skillSaved, s);
  });
  // §3 верификация диктора: прогресс/итог записи отпечатка + список голосов → renderer (вкладка «Голоса»).
  transport.on("voiceEnrollProgress", (p) => win?.webContents.send(IPC.voiceEnrollProgress, p));
  transport.on("voiceEnrollDone", (d) => win?.webContents.send(IPC.voiceEnrollDone, d));
  transport.on("voiceList", (l) => win?.webContents.send(IPC.voiceVoices, l));
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
  ipcMain.on(IPC.playbackActive, (_e, active: boolean) => audio?.setPlaybackActive(Boolean(active)));
  ipcMain.on(IPC.activate, () => audio?.activate());
  ipcMain.on(IPC.mute, () => audio?.mute());
  // Запись/повтор навыков демонстрацией (§8).
  ipcMain.on(IPC.skillStart, (_e, name: string) => void startSkillRecording(name));
  ipcMain.on(IPC.skillStop, () => void stopSkillRecording());
  ipcMain.on(IPC.skillCancel, () => void cancelSkillRecording());
  ipcMain.on(IPC.skillRun, (_e, id: string) => void runSavedSkill(id));
  // §3 верификация диктора. Запись отпечатка использует ТОТ ЖЕ аудиопоток (audio.frame) — поэтому
  // открываем гейт (activate), чтобы кадры пошли; сервер маршрутизирует их в enrollment.
  ipcMain.on(IPC.voiceEnrollStart, (_e, name: string) => {
    audio?.activate();
    transport?.sendVoiceEnrollStart(name);
  });
  ipcMain.on(IPC.voiceEnrollCancel, () => transport?.sendVoiceEnrollCancel());
  ipcMain.on(IPC.voiceList, () => transport?.sendVoiceList());
  ipcMain.on(IPC.voiceRemove, (_e, name: string) => transport?.sendVoiceRemove(name));
  // §6B/B5 вкладка «Оплата»: запрос свежего расхода/лимитов → серверу (ответ придёт usage.info).
  ipcMain.on(IPC.requestUsage, () => transport?.requestUsage());

  // §6 мультимонитор: настройка рабочего монитора Джарвиса — ЛОКАЛЬНО (main), без сервера.
  ipcMain.on(IPC.monitorList, () => win?.webContents.send(IPC.monitorInfo, monitors.monitorList()));
  ipcMain.on(IPC.monitorAssign, (_e, index: number | null) => {
    monitors.setJarvisIndex(typeof index === "number" ? index : null);
    win?.webContents.send(IPC.monitorInfo, monitors.monitorList()); // обновить UI после назначения
  });

  // Настройки (язык/контекст/ключи) — ЛОКАЛЬНО (main), safeStorage для ключей. invoke → ответ-отчёт.
  ipcMain.handle(IPC.settingsGet, () => settingsStore.snapshot());
  ipcMain.handle(IPC.settingsSave, (_e, patch: SettingsPatch) => {
    const res = settingsStore.save(patch);
    // §15: язык/контекст уходят на сервер (профиль → персона).
    const out: ClientSettings = {};
    if (typeof patch.language === "string") out.language = patch.language;
    if (typeof patch.context === "string") out.context = patch.context;
    if (out.language !== undefined || out.context !== undefined) transport?.sendSettings(out);
    // §6B/B4: ключи из UI → серверу (шифрует в user_credentials). KeyName → каноническое имя сервиса.
    // Локально ключи тоже остаются (safeStorage); сервер хранит per-user зашифрованно для hosted-режима.
    const SERVICE: Record<string, string> = { anthropic: "anthropic", eleven: "elevenlabs", deepgram: "deepgram" };
    const keys = Object.entries(patch.keys ?? {})
      .filter(([, v]) => typeof v === "string" && v.trim())
      .map(([k, v]) => ({ service: SERVICE[k] ?? k, value: String(v).trim() }));
    if (keys.length) transport?.sendKeys(keys);
    return res;
  });
}

// ── жизненный цикл приложения ──────────────────────────────────

/** Поднять win-сайдкар (UIA+SendInput, §6), если exe доступен (extraResources). */
// §9: авто-профиль окружения (браузер/приложения) — шлём агенту при каждом подключении (после
// reconnect тоже). Ревью 2026-07-10 (А7): раньше собирался ОДИН раз на процесс Electron и застывал —
// поставленная сегодня игра/CLI не появлялась в окружении до перезапуска клиента. Теперь TTL 6ч.
let envSummary: string | undefined;
// §Волна2 (2.6): структурные списки приложений/игр — лексикон STT-нормализатора на сервере
// (строку summary там не парсим — хрупко).
let envApps: string[] = [];
let envGames: string[] = [];
let envBuiltAt = 0;
const ENV_TTL_MS = 6 * 3_600_000;
async function sendEnvProfile(): Promise<void> {
  try {
    if (envSummary === undefined || Date.now() - envBuiltAt > ENV_TTL_MS) {
      const profile = await buildSystemProfile();
      envSummary = formatProfileSummary(profile);
      envApps = profile.apps.map((a) => a.name);
      envGames = [...(profile.games ?? [])];
      envBuiltAt = Date.now();
      log.info("окружение определено (авто)", { summary: envSummary });
    }
    if (envSummary) transport?.sendEnv(envSummary, envApps, envGames);
  } catch (e) {
    log.warn("профиль окружения не собран", e instanceof Error ? e.message : String(e));
  }
}

// §контекст системы: ЖИВОЙ снимок «что открыто и на каком мониторе» — отдельно от статичного
// окружения, обновляется периодически (отдельный таймер, НЕ на горячем sensors-такте). Так Джарвис
// каждый ход знает, что запущено и где (фикс two-monitor слепоты), без tool-call и round-trip.
let ambientTimer: ReturnType<typeof setInterval> | undefined;
let emptyAmbientStreak = 0; // А8: пустой снимок N раз подряд = мёртвый сенсор, а не «нечего показать»
async function sendAmbient(): Promise<void> {
  try {
    const { summary, foreground } = await captureAmbient();
    // А5 (ревью 2026-07-10): живая ЗАНЯТОСТЬ пользователя — из уже собираемого (fg-окно + idle),
    // ноль новых проб. Одной строкой в снимок (модель знает занятость ДО действия, а не постфактум
    // через denied:USER_BUSY) и в сенсоры §9 (гейт проактива «не мешать в игре» оживает).
    sensors?.setActiveApp(foreground?.process ?? "unknown");
    sensors?.setFullscreen(Boolean(foreground?.fullscreen));
    const idleSec = powerMonitor.getSystemIdleTime();
    const presence =
      `Пользователь: ${idleSec < 60 ? "за ПК" : `отошёл (~${Math.round(idleSec / 60)} мин)`}` +
      `${foreground?.fullscreen ? `; полноэкранно: ${foreground.process}` : ""}.`;
    const combined = [summary, presence].filter((s) => s && s.trim()).join(" ");
    if (summary) {
      emptyAmbientStreak = 0;
      transport?.sendSystem(combined);
    } else {
      emptyAmbientStreak += 1;
      // А8: 5 пустых подряд (=1 минута слепоты) — WARN один раз на серию, не спам.
      if (emptyAmbientStreak === 5) log.warn("ambient-снимок пуст 5 циклов подряд — сенсор окон/звука, похоже, мёртв");
    }
  } catch (e) {
    log.warn("ambient-снимок не отправлен", e instanceof Error ? e.message : String(e));
  }
  if (!ambientTimer) {
    // 12с (было 30с): контекст должен быть СВЕЖИМ — открыл вкладку/включил звук → Джарвис видит почти
    // сразу, без уточнений. Снимок лёгкий (EnumWindows + WASAPI-пик + вкладки), фон, unref.
    ambientTimer = setInterval(() => void sendAmbient(), 12_000);
    ambientTimer.unref?.();
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
    // §Волна2 (2.3): TFM сайдкара поднят до net8.0-windows10.0.19041.0 (WinRT OCR); старый путь —
    // фолбэк для несобранной новой версии.
    join(__dirname, "../../../sidecar-win/bin/Release/net8.0-windows10.0.19041.0/win-x64/publish/SidecarWin.exe"),
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
    const subscribeRawInput = (): void => {
      setTimeout(() => {
        sc.request("raw-input.subscribe", { enable: true }).catch(() => {
          log.warn("raw-input.subscribe не удался — user-takeover недоступен");
        });
      }, 2500);
    };
    subscribeRawInput();
    // §Волна2 (2.4): авто-рестарт сайдкара поднимает НОВЫЙ процесс — подписку надо восстановить,
    // иначе user-takeover молча умирает до перезапуска клиента.
    sc.onRestarted(subscribeRawInput);
  } else {
    log.warn("win-сайдкар не найден — UIA-актуаторы и запись навыков недоступны (соберите apps/sidecar-win)");
  }
}

app.whenReady().then(() => {
  registerIpc();
  startGsiListener(); // §Волна3 (3.4): локальный приёмник JSON-пушей игр/программ (GSI) — сенсор kind:"gsi"
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
