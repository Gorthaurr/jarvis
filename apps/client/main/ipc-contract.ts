/**
 * Контракт IPC между main и renderer (§3, §21).
 *
 * Единственный источник правды для имён каналов и форм сообщений, импортируется
 * и в main (регистрация обработчиков), и в preload (contextBridge-мост), и в renderer
 * (типизация window.jarvis). renderer изолирован (contextIsolation) и НЕ имеет node —
 * всё общение через этот мост.
 */
import type {
  ClientState,
  Transcript,
  ProactiveNudge,
  ConfirmRequest,
  DisplayCard,
  TaskStatus,
  TaskControl,
  SkillSaved,
} from "@jarvis/protocol";

/** Имена IPC-каналов. renderer -> main (invoke/send) и main -> renderer (события). */
export const IPC = {
  // renderer -> main
  submitText: "jarvis:submitText", // dev-текст из поля ввода (M0)
  confirmResult: "jarvis:confirmResult", // ответ на ConfirmRequest (§14)
  taskControl: "jarvis:taskControl", // управление задачей из UI (стоп/пауза, §20)
  pushPcm: "jarvis:pushPcm", // кадр PCM16 из renderer (захват, §3)
  activate: "jarvis:activate", // push-to-talk активация (когда нет wake word, §18)
  mute: "jarvis:mute", // честный mute (§0.6)
  skillStart: "jarvis:skillStart", // начать запись навыка демонстрацией (§8)
  skillStop: "jarvis:skillStop", // завершить запись и сохранить навык (§8)
  skillCancel: "jarvis:skillCancel", // отменить запись без сохранения (§8)
  skillRun: "jarvis:skillRun", // повторить ранее записанный навык (§8)
  // main -> renderer (push-события)
  state: "jarvis:state", // смена ClientState (орб)
  transcript: "jarvis:transcript",
  speakChunk: "jarvis:speakChunk", // аудио-чанк TTS для воспроизведения (§10)
  micState: "jarvis:micState", // гейт микрофона открыт/закрыт (§10)
  bargeIn: "jarvis:bargeIn", // заглушить плеер TTS (barge-in §10)
  nudge: "jarvis:nudge",
  confirmRequest: "jarvis:confirmRequest",
  display: "jarvis:display", // карточка ui.display (§21)
  taskStatus: "jarvis:taskStatus", // прогресс задачи (§20)
  link: "jarvis:link", // online/offline индикатор связи
  skillState: "jarvis:skillState", // состояние записи навыка (запись/счётчик, §8)
  skillSaved: "jarvis:skillSaved", // навык записан/доступен для повтора (§8)
} as const;

/** Состояние записи навыка демонстрацией — для индикатора в UI (§8). */
export interface SkillRecState {
  recording: boolean;
  /** число пойманных значимых действий. */
  count: number;
  /** последнее действие (роль/имя) — для живого фидбэка. */
  last?: string;
  /** sidecar недоступен → запись невозможна (UIA-хук не поднять). */
  unavailable?: boolean;
}

/** Аудио-чанк TTS для renderer (audio — base64; в проде WebRTC, §5). */
export interface SpeakChunkPayload {
  audio: string;
  seq: number;
  last: boolean;
}

/** Полезная нагрузка ответа на подтверждение (§14, с полем revision). */
export interface ConfirmResultPayload {
  requestId: string;
  approved: boolean;
  /** «перепиши короче» -> перегенерация (§14 revise-петля). */
  revision?: string;
}

/** Состояние связи для индикатора. */
export interface LinkState {
  online: boolean;
}

/**
 * API, которое preload выставляет в renderer как window.jarvis.
 * Каждая подписка возвращает функцию-отписку.
 */
export interface JarvisBridge {
  /** Отправить dev-текст (M0 поток §17). */
  submitText(text: string): void;
  /** Ответить на запрос подтверждения (§14). */
  sendConfirmResult(payload: ConfirmResultPayload): void;
  /** Управление задачей из UI (§20): «стоп»/«пауза»/«продолжить». */
  sendTaskControl(action: TaskControl["action"], taskId?: string): void;
  /** Передать кадр PCM16 из захвата renderer в main (§3). */
  pushPcm(pcm: ArrayBuffer): void;
  /** Push-to-talk активация микрофона (§18). */
  activate(): void;
  /** Честный mute (§0.6). */
  mute(): void;
  /** Начать запись навыка демонстрацией (§8). */
  startSkill(name: string): void;
  /** Завершить запись и сохранить навык (§8). */
  stopSkill(): void;
  /** Отменить запись без сохранения (§8). */
  cancelSkill(): void;
  /** Повторить ранее записанный навык по id (§8). */
  runSkill(id: string): void;
  // подписки на события main -> renderer
  onState(cb: (state: ClientState) => void): () => void;
  onTranscript(cb: (t: Transcript) => void): () => void;
  onSpeakChunk(cb: (c: SpeakChunkPayload) => void): () => void;
  onMicState(cb: (open: boolean) => void): () => void;
  onBargeIn(cb: () => void): () => void;
  onNudge(cb: (n: ProactiveNudge) => void): () => void;
  onConfirmRequest(cb: (r: ConfirmRequest) => void): () => void;
  onDisplay(cb: (c: DisplayCard) => void): () => void;
  onTaskStatus(cb: (s: TaskStatus) => void): () => void;
  onLink(cb: (l: LinkState) => void): () => void;
  /** Состояние записи навыка (§8). */
  onSkillState(cb: (s: SkillRecState) => void): () => void;
  /** Навык записан/доступен для повтора (§8). */
  onSkillSaved(cb: (s: SkillSaved) => void): () => void;
}
