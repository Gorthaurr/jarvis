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
import type {
  JarvisBridge,
  ConfirmResultPayload,
  SpeakChunkPayload,
  SkillRecState,
} from "../main/ipc-contract.js";
import type { SkillSaved, VoiceEnrollProgress, VoiceEnrollDone, VoiceList, MonitorList, ChatMessage, UsageInfo } from "@jarvis/protocol";

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
  sendTaskControl: (action, taskId) =>
    ipcRenderer.send(IPC.taskControl, { action, taskId }),
  pushPcm: (pcm: ArrayBuffer) => ipcRenderer.send(IPC.pushPcm, pcm),
  setPlaybackActive: (active: boolean) => ipcRenderer.send(IPC.playbackActive, active),
  activate: () => ipcRenderer.send(IPC.activate),
  mute: () => ipcRenderer.send(IPC.mute),
  startSkill: (name: string) => ipcRenderer.send(IPC.skillStart, name),
  stopSkill: () => ipcRenderer.send(IPC.skillStop),
  cancelSkill: () => ipcRenderer.send(IPC.skillCancel),
  runSkill: (id: string) => ipcRenderer.send(IPC.skillRun, id),
  startVoiceEnroll: (name: string) => ipcRenderer.send(IPC.voiceEnrollStart, name),
  cancelVoiceEnroll: () => ipcRenderer.send(IPC.voiceEnrollCancel),
  listVoices: () => ipcRenderer.send(IPC.voiceList),
  removeVoice: (name: string) => ipcRenderer.send(IPC.voiceRemove, name),
  listMonitors: () => ipcRenderer.send(IPC.monitorList),
  assignMonitor: (index: number | null) => ipcRenderer.send(IPC.monitorAssign, index),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (patch) => ipcRenderer.invoke(IPC.settingsSave, patch),
  requestUsage: () => ipcRenderer.send(IPC.requestUsage),

  onState: (cb) => subscribe(IPC.state, cb),
  onTranscript: (cb) => subscribe(IPC.transcript, cb),
  onChat: (cb) => subscribe<ChatMessage>(IPC.chat, cb),
  onSpeakChunk: (cb) => subscribe<SpeakChunkPayload>(IPC.speakChunk, cb),
  onMicState: (cb) => subscribe<boolean>(IPC.micState, cb),
  onBargeIn: (cb) => subscribe<void>(IPC.bargeIn, () => cb()),
  onNudge: (cb) => subscribe(IPC.nudge, cb),
  onConfirmRequest: (cb) => subscribe(IPC.confirmRequest, cb),
  onDisplay: (cb) => subscribe(IPC.display, cb),
  onTaskStatus: (cb) => subscribe(IPC.taskStatus, cb),
  onLink: (cb) => subscribe(IPC.link, cb),
  onSkillState: (cb) => subscribe<SkillRecState>(IPC.skillState, cb),
  onSkillSaved: (cb) => subscribe<SkillSaved>(IPC.skillSaved, cb),
  onVoiceEnrollProgress: (cb) => subscribe<VoiceEnrollProgress>(IPC.voiceEnrollProgress, cb),
  onVoiceEnrollDone: (cb) => subscribe<VoiceEnrollDone>(IPC.voiceEnrollDone, cb),
  onVoiceList: (cb) => subscribe<VoiceList>(IPC.voiceVoices, cb),
  onMonitors: (cb) => subscribe<MonitorList>(IPC.monitorInfo, cb),
  onUsage: (cb) => subscribe<UsageInfo>(IPC.usage, cb),
};

contextBridge.exposeInMainWorld("jarvis", api);
