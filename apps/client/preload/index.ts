/**
 * preload — мост contextBridge между изолированным renderer и main (§3).
 *
 * renderer запускается с contextIsolation:true и без nodeIntegration — у него НЕТ доступа
 * к require/ipcRenderer напрямую. Этот скрипт в привилегированном контексте выставляет
 * безопасный, узкий API window.jarvis (только нужные каналы, см. ipc-contract.ts).
 */
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import { IPC } from "../main/ipc-contract.js";
import type { JarvisBridge, ConfirmResultPayload } from "../main/ipc-contract.js";

/** Обёртка подписки: возвращает функцию-отписку, чистит листенер. */
function subscribe<T>(channel: string, cb: (data: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, data: T) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: JarvisBridge = {
  submitText: (text) => ipcRenderer.send(IPC.submitText, text),
  sendConfirmResult: (payload: ConfirmResultPayload) =>
    ipcRenderer.send(IPC.confirmResult, payload),

  onState: (cb) => subscribe(IPC.state, cb),
  onTranscript: (cb) => subscribe(IPC.transcript, cb),
  onNudge: (cb) => subscribe(IPC.nudge, cb),
  onConfirmRequest: (cb) => subscribe(IPC.confirmRequest, cb),
  onDisplay: (cb) => subscribe(IPC.display, cb),
  onTaskStatus: (cb) => subscribe(IPC.taskStatus, cb),
  onLink: (cb) => subscribe(IPC.link, cb),
};

contextBridge.exposeInMainWorld("jarvis", api);
