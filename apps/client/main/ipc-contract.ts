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
  // main -> renderer (push-события)
  state: "jarvis:state", // смена ClientState (орб)
  transcript: "jarvis:transcript",
  nudge: "jarvis:nudge",
  confirmRequest: "jarvis:confirmRequest",
  display: "jarvis:display", // карточка ui.display (§21)
  taskStatus: "jarvis:taskStatus", // прогресс задачи (§20)
  link: "jarvis:link", // online/offline индикатор связи
} as const;

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
  // подписки на события main -> renderer
  onState(cb: (state: ClientState) => void): () => void;
  onTranscript(cb: (t: Transcript) => void): () => void;
  onNudge(cb: (n: ProactiveNudge) => void): () => void;
  onConfirmRequest(cb: (r: ConfirmRequest) => void): () => void;
  onDisplay(cb: (c: DisplayCard) => void): () => void;
  onTaskStatus(cb: (s: TaskStatus) => void): () => void;
  onLink(cb: (l: LinkState) => void): () => void;
}
