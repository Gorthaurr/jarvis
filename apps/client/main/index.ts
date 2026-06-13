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
import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { createLogger, envInt, env as readEnv } from "@jarvis/shared";
import type { ClientState } from "@jarvis/protocol";

import { Transport } from "./transport/index.js";
import { dispatch } from "./actuators/index.js";
import * as tier0 from "./tier0/index.js";
import { AudioCoordinator } from "./audio/index.js";
import { IPC } from "./ipc-contract.js";
import type { ConfirmResultPayload } from "./ipc-contract.js";

const log = createLogger("main");

// Сборка main идёт в CommonJS (esbuild format=cjs), поэтому __dirname доступен нативно
// и указывает на dist/main. Пути к preload/renderer строим относительно него.

let win: BrowserWindow | null = null;
let transport: Transport | null = null;
const audio = new AudioCoordinator();

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
  win = new BrowserWindow({
    width: 420,
    height: 640,
    title: "Jarvis",
    backgroundColor: "#0b0d12",
    webPreferences: {
      // §3: renderer изолирован; node-доступа нет, только мост preload.
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload использует require('electron') — sandbox=false для contextBridge-моста
    },
  });

  win.loadFile(join(__dirname, "../renderer/index.html"));
  win.on("closed", () => {
    win = null;
  });

  // Открыть DevTools в dev-режиме (не в упакованном приложении).
  if (!app.isPackaged) win.webContents.openDevTools({ mode: "detach" });
}

/** Поднять транспорт и связать его события с renderer-IPC. */
function startTransport(): void {
  transport = new Transport(transportConfig(), dispatch);

  transport.on("connected", (hello) => {
    log.info(`подключено к серверу: session=${hello.sessionId}`);
    win?.webContents.send(IPC.link, { online: true });
    setState("idle");
  });
  transport.on("link", (l) => win?.webContents.send(IPC.link, l));
  transport.on("disconnected", () => win?.webContents.send(IPC.link, { online: false }));

  transport.on("transcript", (t) => win?.webContents.send(IPC.transcript, t));
  transport.on("nudge", (n) => win?.webContents.send(IPC.nudge, n));
  transport.on("confirmRequest", (r) => win?.webContents.send(IPC.confirmRequest, r));
  transport.on("display", (c) => win?.webContents.send(IPC.display, c));
  transport.on("taskStatus", (s) => win?.webContents.send(IPC.taskStatus, s));
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

/** Регистрация IPC-обработчиков renderer -> main. */
function registerIpc(): void {
  ipcMain.on(IPC.submitText, (_e, text: string) => void handleSubmitText(text));
  ipcMain.on(IPC.confirmResult, (_e, payload: ConfirmResultPayload) => {
    transport?.sendConfirmResult(payload.requestId, payload.approved, payload.revision);
  });
}

// ── жизненный цикл приложения ──────────────────────────────────

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  startTransport();

  // Аудио на M0 — стаб (вход текстом). Координатор поднят для будущей связки (§3, M1).
  void audio;

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
});
