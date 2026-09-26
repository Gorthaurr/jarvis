/**
 * Bootstrap main-процесса Electron (§3).
 *
 * Поднимает окно (renderer), инициализирует транспорт (WS к серверу), актуаторы,
 * аудио-координацию (стаб) и связывает всё через IPC-мост (preload).
 *
 * Поток текста (§17):
 *   пользователь вводит текст в поле renderer
 *     -> main шлёт dev.text на сервер ВСЕГДА (tier0 — серверный, с откатом в модель; 26.09 клиентский убран)
 *        -> сервер вернёт action.command (напр. app.launch)
 *        -> transport исполнит через actuators -> вернёт action.result
 *     -> состояние (idle/thinking/...) прокидывается в renderer (орб).
 */
import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, powerMonitor, screen, session } from "electron";
import { join } from "node:path";
import { createLogger, envInt, env as readEnv } from "@jarvis/shared";
import type { ClientState, TaskControl, DemoEvent, SkillSaved, SkillStep, ClientSettings } from "@jarvis/protocol";

import { existsSync } from "node:fs";
import { Transport } from "./transport/index.js";
import { dispatch, ownerPresenceNow } from "./actuators/index.js";
import { noteOwnerInput } from "./actuators/input-mark.js";
import { type ActBridge, startActBridge } from "./actuators/act-bridge.js";
import { guardedDispatch } from "./actuators/commit-guard.js";
import { createSherpaHearing } from "./hearing/sherpa-hearing.js";
import { setActBridge } from "./actuators/code-runner.js";
import { submitTypedText } from "./submit-text.js";
import { monitors } from "./monitors.js";
import { selectionStore } from "./selection/store.js";
import { type SelectionWiring, wireSelection } from "./selection/wiring.js";
import { selectionOverlay } from "./selection/overlay.js";
import { selectionClear, selectionStart } from "./actuators/selection.js";
import { startGsiListener } from "./sensors/gsi-listener.js";
import { settingsStore } from "./settings-store.js";
import { identityStore } from "./identity-store.js";
import { deviceTokenStore } from "./device-token-store.js";

/** env-токен jdt_ + сохранённый наследник ротации → наследник; иначе env, иначе стор. */
function pickClientToken(envToken: string, stored: string | undefined): string {
  if (envToken.startsWith("jdt_") && stored) return stored;
  return envToken || stored || "";
}

/** Заголовки карточек для кодов ошибок протокола, после которых транспорт не реконнектится. */
const PROTOCOL_ERROR_TITLES: Record<string, string> = {
  version_mismatch: "Требуется обновление",
  login_required: "Нужен вход",
  device_revoked: "Устройство отозвано",
  subscription_required: "Нужна подписка",
  account_blocked: "Аккаунт заблокирован",
};
import { AudioCoordinator } from "./audio/index.js";
import { MicControl } from "./audio/mic-control.js";
import { registerPttHotkey } from "./audio/ptt-hotkey.js";
import { wireRendererGuard } from "./obs/renderer-guard.js";
import { installProcessGuard } from "./obs/process-guard.js";
import { sidecar } from "./actuators/sidecar-client.js";
import { browserController } from "./actuators/browser-cdp.js";
import { buildSystemProfile, detectInstalledApps, formatProfileSummary } from "./sensors/system-profiler.js";
import { captureAmbient } from "./sensors/system-snapshot.js";
import { UsageProfile } from "./sensors/usage-profile.js";
import { Sensors } from "./sensors/index.js";
import { runSkill } from "./skill-runner/index.js";
import { createClientActuator } from "./skill-runner/client-actuator.js";
import { IPC } from "./ipc-contract.js";
import type { ConfirmResultPayload, SkillRecState, SettingsPatch } from "./ipc-contract.js";
import { disposeClientFileLog, initClientFileLog } from "./obs/file-log.js";
import { clearOwnerQuit, markOwnerQuit } from "./owner-quit.js";

const log = createLogger("main");

/**
 * Ревью 2026-09-24 (H-L2): аварийный выход — дослать хвост durable-лога и погасить детей best-effort,
 * затем ненулевой код (его видит хранитель супервизора). before-quit при app.exit не срабатывает.
 */
function hardExit(code: number): void {
  isQuitting = true;
  try {
    sidecar().stop();
    transport?.stop();
    usageProfileInst?.flush(); // H-W1: минуты фокуса не теряются и на аварийном выходе
  } catch {
    /* выходим в любом случае (в т.ч. если сбой случился ещё до инициализации модуля) */
  }
  disposeClientFileLog();
  app.exit(code);
}
// Ревью 2026-09-24 (H-L2): необработанные ошибки main больше не уходят в модальный диалог Electron и тишину
// лога: фатальное — exit(1) (хранитель поднимет), шум сети/потерянные промисы — лог (см. obs/process-guard.ts).
installProcessGuard({
  on: (ev, cb) => void process.on(ev, cb),
  streams: [process.stdout, process.stderr],
  log,
  flush: () => disposeClientFileLog(),
  exit: (code) => hardExit(code),
});

// §10: Джарвис говорит сам (онбординг/проактивность) без жеста пользователя.
// Без этого Chromium держит AudioContext в suspended — голос молчит.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// §живёт-сам (адверс-ревью 2026-07-28 [15]): ОДИН экземпляр. С автозапуском+треем повторный запуск
// (ярлык при уже живущем в трее клиенте) давал бы ДВА полных экземпляра — двойной захват микрофона,
// двойной WS, двойные актуаторы. Второй экземпляр показывает окно первого и выходит.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      win.show();
      win.focus();
    } else {
      createWindow();
    }
  });
}

// Сборка main идёт в CommonJS (esbuild format=cjs), поэтому __dirname доступен нативно
// и указывает на dist/main. Пути к preload/renderer строим относительно него.

let win: BrowserWindow | null = null;
let transport: Transport | null = null;
let audio: AudioCoordinator | null = null;
let audioSeq = 0;
/** Текущее состояние связи — чтобы переслать его, когда renderer догрузится (race-fix). */
let linkOnline = false;
// §живёт-сам (аудит 2026-07-28, P0 «случайный крестик убивает слух/голос/сенсоры»): закрытие окна
// теперь прячет его в ТРЕЙ, приложение продолжает слушать. Явный выход — только из меню трея /
// before-quit. isQuitting отличает «спрятать» от настоящего завершения.
let tray: Tray | null = null;
let isQuitting = false;
// §0.6 mic-kill-switch (адверс-ревью 2026-07-28 [2]): main ПОМНИТ волю владельца «микрофон выключен».
// Раньше запись голоса (voiceEnrollStart → activate) открывала гейт НАВСЕГДА при взведённом mute в UI —
// красная кнопка врала «не слышит», а кадры уходили в облако. Теперь после done/cancel записи гейт
// восстанавливается по этому флагу. Ревью 2026-09-24 (B-F8): включение кнопкой ПОСЛЕ «выключить» —
// push-to-talk (см. audio/mic-control.ts); стартовая синхронизация renderer гейт не открывает.
const mic = new MicControl(() => audio);
/** Идёт запись голосового отпечатка (гейт открыт ВРЕМЕННО) — чтобы вернуть mute на любом её исходе. */
let voiceEnrollInFlight = false;
/** Вернуть гейт микрофона в состояние, выбранное владельцем (после временного открытия на запись голоса). */
function restoreMicMute(reason: string): void {
  voiceEnrollInFlight = false;
  if (mic.killSwitchOn && audio) {
    audio.mute();
    log.info("§0.6 гейт микрофона закрыт обратно (mic-kill-switch владельца)", { reason });
  } else {
    audio?.release(); // W1: снять удержание записи — при локальном wake гейт вернётся к «закрыт до „Джарвис“»
  }
}
/** 16×16 иконка трея (синий орб) — data-URL, без файловых зависимостей (работает и в dev, и в упаковке). */
const TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAO0lEQVR42mNgoAWw6fn/HxumSDNRhhDSjNcQYjVjNYRUzRiGYJN89gEVj0QDaB4T1E9IVEnKVMlMpAIAk4jBmKEfHTcAAAAASUVORK5CYII=";

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
  // Продукт: env-токен jdt_ мог быть ротирован сервером — персистнутый наследник (safeStorage) главнее, иначе
  // через час старый токен даёт login_required; без env — стор, потом per-install UUID, потом dev-token.
  const token = pickClientToken(readEnv("JARVIS_CLIENT_TOKEN", ""), deviceTokenStore.get()) || identityStore.getOrCreateInstallId() || "dev-token";
  return {
    host: readEnv("HOST", "127.0.0.1"),
    port: envInt("PORT", 8787),
    // §6B/B2: приоритет — явный JARVIS_CLIENT_TOKEN (континьюити power-юзера) → per-install UUID
    // (опт-ин JARVIS_CLIENT_IDENTITY) → дефолт 'dev-token' (→ DEV_USER, существующая установка цела).
    token,
    // Привязка device-токена к установке: с jdt_ installId уходит ВСЕГДА (сервер требует его у привязанного
    // токена; опт-ин JARVIS_CLIENT_IDENTITY для этого не нужен). С dev-token — как раньше.
    installId: token.startsWith("jdt_") ? identityStore.getOrCreateInstallId({ force: true }) : identityStore.getOrCreateInstallId(),
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
  // Ревью 2026-09-24 (H-L2): захват микрофона и голос живут в renderer — его падение/зависание больше не
  // делает Джарвиса молча глухим: reload с бэкоффом, серия — перезапуск процесса (obs/renderer-guard.ts).
  const w = win;
  wireRendererGuard({
    onGone: (cb) => void w.webContents.on("render-process-gone", (_e, details) => cb(details.reason)),
    onUnresponsive: (cb) => void w.on("unresponsive", cb),
    onResponsive: (cb) => void w.on("responsive", cb),
    reload: () => {
      if (!w.isDestroyed()) w.webContents.reload();
    },
    crashRenderer: () => {
      if (!w.isDestroyed()) w.webContents.forcefullyCrashRenderer();
    },
    relaunch: (args) => app.relaunch({ args }),
    exit: (code) => hardExit(code),
    isQuitting: () => isQuitting,
    // Плеер умер вместе с renderer — «звук играет» сниматься иначе некому (сервер держал бы очередь озвучки).
    onRendererLost: () => {
      audio?.setPlaybackActive(false);
      transport?.sendPlaybackState(false);
    },
    argv: process.argv.slice(1),
    log,
  });
  // §живёт-сам: крестик = спрятать в трей (слух/сенсоры живут), НЕ завершение. Выход — меню трея.
  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win?.hide();
    }
  });
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

/** jarvis SDK: loopback-мост актуаторов (для code_run-скриптов) — держим ссылку, чтобы погасить на выходе. */
let actBridge: ActBridge | null = null;

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
  // W1: локальный слух (sherpa KWS «Джарвис» + Silero VAD) грузится асинхронно; нет моделей/пакета →
  // остаёмся на заглушках (гейт открыт постоянно, wake по тексту облака), клиент не падает.
  if (process.env.JARVIS_LOCAL_WAKE !== "0") {
    void createSherpaHearing({ onWake: (keyword) => log.info("локальный wake «Джарвис»", { keyword }) })
      .then((h) => {
        if (h) audio?.setEngines({ wake: h.wake, vad: h.vad });
      })
      .catch((e) => log.warn("слух: ошибка инициализации", { error: e instanceof Error ? e.message : String(e) }));
  }

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
    selectionOnConnected?.(); // §выделение: рамка пережила обрыв — сервер должен знать о ней (с её возрастом)
    // §15: досылаем сохранённые язык/контекст серверу (робастно к оффлайн-сейву/реконнекту).
    const snap = settingsStore.snapshot();
    // 2026-09-02: выбор модели — тем же сообщением; сервер отвечает models.catalog с тем, что применилось.
    // На (ре)коннекте шлём ТОЛЬКО явный локальный выбор: {} = «сбросить» и уходит лишь с кнопки «Сохранить»
    // (ревью: иначе реконнект молча стирал выбор, сделанный с другого устройства/через API).
    transport?.sendSettings({ language: snap.language, context: snap.context, ...(snap.models ? { models: snap.models } : {}) });
  });
  transport.on("link", (l) => {
    linkOnline = l.online;
    win?.webContents.send(IPC.link, l);
  });
  transport.on("disconnected", () => {
    linkOnline = false;
    win?.webContents.send(IPC.link, { online: false });
    // Контрольное ревью: обрыв WS/рестарт сервера ПОСРЕДИ записи голоса убивает серверный enroll —
    // voice.enroll.done не придёт НИКОГДА, и временно открытый гейт микрофона остался бы открыт
    // навсегда при красной кнопке «Джарвис не слышит». Возвращаем волю владельца на любом исходе.
    if (voiceEnrollInFlight) restoreMicMute("voice-enroll-interrupted");
  });

  transport.on("transcript", (t) => win?.webContents.send(IPC.transcript, t));
  transport.on("chat", (m) => win?.webContents.send(IPC.chat, m)); // §22 чат-история
  transport.on("usage", (u) => win?.webContents.send(IPC.usage, u)); // §6B/B5 расход/лимиты → вкладка «Оплата»
  transport.on("modelsCatalog", (m) => win?.webContents.send(IPC.modelsCatalog, m)); // 2026-09-02 каталог моделей → селекты «Модель»
  transport.on("memory", (m) => win?.webContents.send(IPC.memory, m)); // волна E: снимок памяти → вкладка «Память»
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
  transport.on("voiceEnrollDone", (d) => {
    win?.webContents.send(IPC.voiceEnrollDone, d);
    restoreMicMute("voice-enroll-done"); // адверс-ревью [2]: запись кончилась → возвращаем волю владельца
  });
  transport.on("voiceList", (l) => win?.webContents.send(IPC.voiceVoices, l));
  // Продукт: ротированный device-токен — в шифрованный стор (иначе после рестарта клиент предъявил бы старый,
  // а тот доживает лишь час → повторный вход).
  transport.on("tokenRotated", (raw) => {
    if (!deviceTokenStore.set(raw)) log.warn("device-токен ротирован сервером, но не сохранён локально — после рестарта клиента понадобится вход");
  });
  let lastProtocolErrorCode: string | undefined;
  transport.on("protocolError", (e) => {
    // version_mismatch -> «требуется обновление»: карточкой в renderer (§5). Продуктовые коды (нужен вход /
    // устройство отозвано / нужна подписка) — транспорт на них не реконнектится, карточка ОДНА на код.
    if (e.code === "device_revoked") deviceTokenStore.clear(); // отозванный токен предъявлять больше незачем
    if (e.code === lastProtocolErrorCode && PROTOCOL_ERROR_TITLES[e.code]) return;
    lastProtocolErrorCode = e.code;
    win?.webContents.send(IPC.display, {
      title: PROTOCOL_ERROR_TITLES[e.code] ?? "Ошибка",
      markdown: e.message,
    });
    setState("idle");
  });

  transport.start();
}

/** Текст из чата renderer → мозг целиком (tier0 — только серверный; см. submit-text.ts). */
function handleSubmitText(text: string): void {
  submitTypedText(text, {
    send: (t) => transport?.sendDevText(t) ?? false,
    setState,
    notify: (title, markdown) => win?.webContents.send(IPC.display, { title, markdown }),
    log,
  });
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
  ipcMain.on(IPC.playbackActive, (_e, active: boolean) => {
    audio?.setPlaybackActive(Boolean(active));
    // Волна B: тот же факт — серверу. Он ждёт РЕАЛЬНОГО освобождения динамика, прежде чем отдать
    // следующую очередную реплику (раньше знал только про конец СИНТЕЗА → фразы шли «пачкой»).
    transport?.sendPlaybackState(Boolean(active));
  });
  // Realtime инкремент 0: рендерер начал воспроизведение первого звука хода → на сервер (mouth-to-ear).
  ipcMain.on(IPC.audioPlayed, (_e, gen: number, ts: number) => {
    if (typeof gen === "number" && typeof ts === "number") transport?.sendAudioPlayed(gen, ts);
  });
  // Владелец явно включил слух; включение кнопкой после «выключить» = push-to-talk (B-F8, mic-control.ts).
  ipcMain.on(IPC.activate, () => void mic.activate());
  // §0.6: main помнит волю владельца — enroll/прочие пути не откроют гейт «навсегда».
  ipcMain.on(IPC.mute, () => mic.mute());
  // Запись/повтор навыков демонстрацией (§8).
  ipcMain.on(IPC.skillStart, (_e, name: string) => void startSkillRecording(name));
  ipcMain.on(IPC.skillStop, () => void stopSkillRecording());
  ipcMain.on(IPC.skillCancel, () => void cancelSkillRecording());
  ipcMain.on(IPC.skillRun, (_e, id: string) => void runSavedSkill(id));
  // §3 верификация диктора. Запись отпечатка использует ТОТ ЖЕ аудиопоток (audio.frame) — поэтому
  // открываем гейт (activate), чтобы кадры пошли; сервер маршрутизирует их в enrollment.
  // Адверс-ревью 2026-07-28 [2]: при взведённом mic-kill-switch запись голоса открывает гейт ВРЕМЕННО
  // (владелец явно записывает голос) — после done/cancel гейт ЗАКРЫВАЕТСЯ ОБРАТНО (restoreMicMute),
  // иначе UI («Микрофон выключен») врал бы, а кадры уходили в облако навсегда.
  ipcMain.on(IPC.voiceEnrollStart, (_e, name: string) => {
    voiceEnrollInFlight = true;
    audio?.activate({ hold: true }); // W1: запись идёт вне хода — idle сервера гейт не закрывает
    transport?.sendVoiceEnrollStart(name);
  });
  ipcMain.on(IPC.voiceEnrollCancel, () => {
    transport?.sendVoiceEnrollCancel();
    restoreMicMute("voice-enroll-cancel");
  });
  ipcMain.on(IPC.voiceList, () => transport?.sendVoiceList());
  ipcMain.on(IPC.voiceRemove, (_e, name: string) => transport?.sendVoiceRemove(name));
  // §6B/B5 вкладка «Оплата»: запрос свежего расхода/лимитов → серверу (ответ придёт usage.info).
  ipcMain.on(IPC.requestUsage, () => transport?.requestUsage());
  // Волна E вкладка «Память»: снимок накопленного о владельце + точечное забывание (ответ — memory.state).
  ipcMain.on(IPC.requestMemory, (_e, query?: string) => transport?.requestMemory(typeof query === "string" ? query : undefined));
  ipcMain.on(IPC.forgetMemory, (_e, req: { layer: "fact" | "episode"; id: string; query?: string }) => {
    if (req && (req.layer === "fact" || req.layer === "episode") && typeof req.id === "string") {
      transport?.forgetMemory(req.layer, req.id, typeof req.query === "string" ? req.query : undefined);
    }
  });

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
    // 2026-09-02: выбор модели — в НОРМАЛИЗОВАННОМ виде из стора ({} = авто → сервер снимает выбор).
    if (patch.models && typeof patch.models === "object") out.models = settingsStore.snapshot().models ?? {};
    if (out.language !== undefined || out.context !== undefined || out.models !== undefined) transport?.sendSettings(out);
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
let envInstalled: Array<{ name: string; exe?: string; uri?: string; cli?: boolean }> = [];
// W4.2: накопитель фокуса (минуты по процессу переднего окна) — durable в userData; топ едет в client.env.usage.
let usageProfileInst: UsageProfile | undefined;
function usageProfile(): UsageProfile {
  if (!usageProfileInst) {
    let base = process.cwd();
    try {
      base = app.getPath("userData");
    } catch {
      /* до app.ready — мягкий фолбэк */
    }
    usageProfileInst = new UsageProfile(join(base, "usage-profile.json"));
  }
  return usageProfileInst;
}
let envBuiltAt = 0;
const ENV_TTL_MS = 6 * 3_600_000;
/**
 * §РЕЖИМ ВЫДЕЛЕНИЯ (2026-09-03): владелец обводит кусок экрана и говорит о нём «вот тут недочёт».
 *
 * Здесь три проводки: (1) результат окна-оверлея → координатор выделения; (2) любое изменение
 * области → сервер (client.selection), чтобы Джарвис КАЖДЫЙ ход знал, на что показывают, без
 * tool-call; (3) глобальная клавиша — обвести можно и молча, руками, в том числе поверх игры.
 *
 * Клавиша настраивается JARVIS_SELECTION_HOTKEY (пусто = не регистрировать вовсе). Занята другой
 * программой → ЧЕСТНЫЙ WARN: молча «зарегистрированный» и не работающий хоткей — обещание, которого
 * нет (голосовая команда при этом работает).
 */
function setupSelection(): void {
  // Логика — в selection/wiring.ts (тестируется на подделках); здесь только Electron-примитивы.
  const wiring = wireSelection({
    store: selectionStore,
    overlay: selectionOverlay,
    sendSelection: (sel, ageMs, drawing) => transport?.sendSelection(sel, ageMs, drawing),
    displays: () => screen.getAllDisplays().map((d) => d.bounds),
    onDisplaysChanged: (cb) => {
      screen.on("display-added", () => cb("display-added"));
      screen.on("display-removed", () => cb("display-removed"));
      screen.on("display-metrics-changed", () => cb("display-metrics-changed"));
    },
    onOverlayDone: (cb) => ipcMain.on("selection:done", (e, rect: { x: number; y: number; w: number; h: number } | null) => cb(e.sender.id, rect)),
    registerHotkey: (accel, cb) => globalShortcut.register(accel, cb),
    // force: клавиша — явная воля владельца рисовать (в т.ч. перерисовать только что обведённое).
    start: () => selectionStart(0, { force: true }),
    clear: (o) => selectionClear(o),
    hotkey: readEnv("JARVIS_SELECTION_HOTKEY", "Control+Alt+X"),
    onConnected: (cb) => {
      selectionOnConnected = cb;
    },
  });
  selectionHotkeyActive = wiring.hotkey;
  selectionWiring = wiring;
}

/** Зарегистрированная клавиша «обвести область» (null = нет) — уходит серверу в client.env для паспорта. */
let selectionHotkeyActive: string | null = null;
let selectionWiring: SelectionWiring | null = null;
/** Колбэк проводки выделения на (ре)коннект — зовётся из обработчика transport "connected". */
let selectionOnConnected: (() => void) | null = null;

async function sendEnvProfile(): Promise<void> {
  try {
    if (envSummary === undefined || Date.now() - envBuiltAt > ENV_TTL_MS) {
      const profile = await buildSystemProfile();
      envSummary = formatProfileSummary(profile);
      envApps = profile.apps.map((a) => a.name);
      envGames = [...(profile.games ?? [])];
      // Реестр программных каналов: РЕАЛЬНО установленное с машины (реестр Windows), а не 9 хардкодов.
      // Сопоставление с рецептами — на сервере; сюда идут только факты. Тот же TTL, что у профиля.
      envInstalled = await detectInstalledApps();
      // CLI-команды, найденные на PATH (detectAutomationTools), — тоже канал: рецепты матчатся по
      // имени команды. Без этого треть курируемых рецептов (git/ffmpeg/ollama/blender) была
      // недостижима — поле cli объявлено в протоколе, но его никто не заполнял (адверс-ревью).
      for (const t of profile.tools) envInstalled.push({ name: t.id, cli: true });
      envBuiltAt = Date.now();
      log.info("окружение определено (авто)", { summary: envSummary });
    }
    if (envSummary) transport?.sendEnv(envSummary, envApps, envGames, envInstalled, selectionHotkeyActive, usageProfile().top(20));
  } catch (e) {
    log.warn("профиль окружения не собран", e instanceof Error ? e.message : String(e));
  }
}

// §контекст системы: ЖИВОЙ снимок «что открыто и на каком мониторе» — отдельно от статичного
// окружения, обновляется периодически (отдельный таймер, НЕ на горячем sensors-такте). Так Джарвис
// каждый ход знает, что запущено и где (фикс two-monitor слепоты), без tool-call и round-trip.
/** Период снимка ПК; им же считается фокус в накопителе W4.2. */
const AMBIENT_TICK_MS = 12_000;
let ambientTimer: ReturnType<typeof setInterval> | undefined;
let emptyAmbientStreak = 0; // А8: пустой снимок N раз подряд = мёртвый сенсор, а не «нечего показать»
async function sendAmbient(): Promise<void> {
  try {
    const { summary, foreground } = await captureAmbient();
    const p = ownerPresenceNow();
    // W4.2: минуты фокуса по процессу — единственный честный источник «самых частых программ» (см. usage-profile.ts).
    // Ревью 2026-09-24 (H-W1): только пока владелец за ПК и экран не заблокирован — иначе счёт шёл за ночь
    // с открытым браузером и за окна, которые двигал сам Джарвис.
    usageProfile().tickFocus(foreground?.process, AMBIENT_TICK_MS, { presence: p.state, locked: sensors?.snapshot().locked ?? false });
    // А5 (ревью 2026-07-10): живая ЗАНЯТОСТЬ пользователя — из уже собираемого (fg-окно + idle),
    // ноль новых проб. Одной строкой в снимок (модель знает занятость ДО действия, а не постфактум
    // через denied:USER_BUSY) и в сенсоры §9 (гейт проактива «не мешать в игре» оживает).
    sensors?.setActiveApp(foreground?.process ?? "unknown");
    sensors?.setFullscreen(Boolean(foreground?.fullscreen));
    // 🔴 Присутствие считаем БЕЗ собственного ввода Джарвиса (разбор «Доты» 2026-09-02): сырой
    // системный idle сбрасывается нашим же SendInput, и на каждой GUI-задаче снимок утверждал
    // «владелец за ПК», даже если его нет в комнате. Не знаем — так и пишем: выдуманное присутствие
    // модель использует как объяснение своих провалов («ввод не отдают — вы за компьютером»).
    const presenceWord =
      p.state === "at_pc" ? "за ПК" : p.state === "away" ? `отошёл (~${p.idleMin} мин)` : "не знаю (последний ввод — мой)";
    const presence = `Пользователь: ${presenceWord}${foreground?.fullscreen ? `; полноэкранно: ${foreground.process}` : ""}.`;
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
    ambientTimer = setInterval(() => void sendAmbient(), AMBIENT_TICK_MS);
    ambientTimer.unref?.();
  }
}

// §6 user-takeover: дебаунс физического ввода → пауза/возобновление агента на сервере.
// Взял мышь/клаву → сразу takeover(true); по простою TAKEOVER_IDLE_MS — takeover(false).
const TAKEOVER_IDLE_MS = 1500;
let userActive = false;
let userIdleTimer: ReturnType<typeof setTimeout> | undefined;
function noteUserInput(): void {
  // 🔴 Достоверное присутствие владельца (ревью 2026-09-02): сайдкар уже отличил живой ввод от нашей
  // синтетики — сигнал иммунен к маскировке нашими же кликами, в отличие от глобального idle.
  noteOwnerInput();
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

/** §живёт-сам: иконка в трее — показать окно / выйти. Приложение живёт в трее и без окна. */
function createTray(): void {
  try {
    const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
    tray = new Tray(icon);
    tray.setToolTip("Джарвис — слушает в фоне");
    const showWindow = (): void => {
      if (win) {
        win.show();
        win.focus();
      } else {
        createWindow();
      }
    };
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Показать Джарвиса", click: showWindow },
        { type: "separator" },
        {
          label: "Выйти (остановить Джарвиса)",
          click: () => {
            isQuitting = true;
            markOwnerQuit(app.getPath("userData")); // хранитель в супервизоре не поднимет клиент обратно
            app.quit();
          },
        },
      ]),
    );
    tray.on("double-click", showWindow);
  } catch (e) {
    log.warn("трей не поднялся — работаем без него", { error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * §живёт-сам: автозапуск клиента с Windows. ЯВНОЕ управление через env (не трогаем реестр молча):
 * JARVIS_AUTOSTART=1 → зарегистрировать (в dev-режиме прописывает electron.exe + путь приложения),
 * JARVIS_AUTOSTART=0 → снять. Не задан → ничего не меняем (уважение к ручной настройке владельца).
 */
function applyAutostart(): void {
  const v = process.env.JARVIS_AUTOSTART;
  if (v !== "1" && v !== "0") return;
  try {
    if (v === "1") {
      // Адверс-ревью [13]: путь приложения в args ОБЯЗАН быть квотирован — реестровая строка Run
      // склеивается в командную строку, путь с пробелом иначе рассыпается на два аргумента.
      app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: [`"${app.getAppPath()}"`] });
      log.info("автозапуск с Windows включён", { exe: process.execPath });
    } else {
      app.setLoginItemSettings({ openAtLogin: false });
      log.info("автозапуск с Windows снят");
    }
  } catch (e) {
    log.warn("не удалось применить настройку автозапуска", { error: e instanceof Error ? e.message : String(e) });
  }
}

// Контрольное ревью: бутстрап ТОЛЬКО у владельца лока — иначе второй экземпляр успевал поднять
// IPC/трей/транспорт/сайдкар до того, как отработает app.quit() (гонка между whenReady и quit).
if (gotSingleInstanceLock) void app.whenReady().then(bootstrap);

function bootstrap(): void {
  initClientFileLog(); // §наблюдаемость (аудит 2026-07-28): durable-лог клиента — «вчера не слышал» больше не слеп
  clearOwnerQuit(app.getPath("userData")); // клиент снова запущен — прошлое «Выйти» больше не действует
  registerIpc();
  startGsiListener(); // §Волна3 (3.4): локальный приёмник JSON-пушей игр/программ (GSI) — сенсор kind:"gsi"
  createWindow();
  createTray(); // §живёт-сам: окно можно закрыть — Джарвис остаётся в трее
  applyAutostart();
  startTransport();
  startSidecar();
  setupSelection(); // §режим выделения: горячая клавиша, приём рамки из оверлея, отправка её серверу
  // Ревью 2026-09-24 (B-F8): запасной путь при промахе локального «Джарвис» — глобальный push-to-talk.
  registerPttHotkey({
    register: (accel, cb) => globalShortcut.register(accel, cb),
    onPress: () => {
      if (audio?.pushToTalk("hotkey") === false) {
        win?.webContents.send(IPC.display, { title: "Микрофон выключен", markdown: "Push-to-talk не открывает выключенный микрофон — включите его кнопкой в окне." });
      }
    },
    log,
  });
  // jarvis SDK (среда исполнения «1 раунд = вся задача»): поднимаем loopback-мост актуаторов и отдаём
  // его code-runner'у, чтобы python-скрипт модели драйвил актуаторы ОДНИМ скриптом (jarvis.*), не бегая
  // в LLM между шагами. Сбой не критичен (обычный code_run/актуаторы работают) — jarvis-скрипт честно упадёт.
  // W0: рискованный коммит (Enter в мессенджере/банке/1С) с моста — честный отказ, не исполнение (см. commit-guard).
  void startActBridge(guardedDispatch(dispatch))
    .then((bridge) => {
      actBridge = bridge;
      setActBridge({ port: bridge.port, token: bridge.token });
    })
    .catch((e) => log.warn("act-bridge не поднялся — jarvis SDK недоступен", { error: e instanceof Error ? e.message : String(e) }));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on("window-all-closed", () => {
  // §живёт-сам (аудит 2026-07-28): раньше закрытие окна ЗАВЕРШАЛО приложение — случайный крестик
  // останавливал слух/голос/сенсоры/GSI. Теперь Джарвис живёт в трее; выход — только меню трея.
});

app.on("before-quit", () => {
  isQuitting = true; // штатный quit (вкл. системный shutdown) не должен блокироваться close-to-tray
  globalShortcut.unregisterAll(); // §выделение: отдаём горячую клавишу системе
  selectionOverlay.hideAll("quit"); // прозрачные окна поверх экрана не переживают приложение
  transport?.stop();
  sidecar().stop();
  void actBridge?.stop(); // jarvis SDK: гасим loopback-мост актуаторов
  void browserController().close(); // §6: гасим управляемый браузер (не оставляем висеть)
  tray?.destroy();
  usageProfileInst?.flush(); // H-W1: дебаунс записи 30 с — без флаша последние минуты фокуса терялись на выходе
  disposeClientFileLog(); // дослать хвост durable-лога
});
