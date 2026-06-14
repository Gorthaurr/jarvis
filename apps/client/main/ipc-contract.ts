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
} from "@jarvis/protocol";

/** Имена IPC-каналов. renderer -> main (invoke/send) и main -> renderer (события). */
export const IPC = {
  // renderer -> main
  submitText: "jarvis:submitText", // dev-текст из поля ввода (M0)
  confirmResult: "jarvis:confirmResult", // ответ на ConfirmRequest (§14)
  pushPcm: "jarvis:pushPcm", // кадр PCM16 из renderer (захват, §3)
  activate: "jarvis:activate", // push-to-talk активация (когда нет wake word, §18)
  mute: "jarvis:mute", // честный mute (§0.6)
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
} as const;

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
  /** Передать кадр PCM16 из захвата renderer в main (§3). */
  pushPcm(pcm: ArrayBuffer): void;
  /** Push-to-talk активация микрофона (§18). */
  activate(): void;
  /** Честный mute (§0.6). */
  mute(): void;
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
}
