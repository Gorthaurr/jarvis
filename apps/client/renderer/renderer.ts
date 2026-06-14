/**
 * Renderer-логика (§3, §21).
 *
 * UI: орб состояния, dev-поле ввода (M0), модалка подтверждения send/order с полем revision (§14),
 * область карточек ui.display (§21). Доступ к main — ТОЛЬКО через window.jarvis (preload-мост).
 *
 * Аудио (§3): захват/воспроизведение живут ЗДЕСЬ (WebRTC AEC). На M0 — стаб getUserMedia
 * с echoCancellation:true для проверки прав на микрофон; реальный стрим — в M1.
 */
import type {
  ClientState,
  Transcript,
  ProactiveNudge,
  ConfirmRequest,
  DisplayCard,
  TaskStatus,
} from "@jarvis/protocol";
import type { JarvisBridge, LinkState, SpeakChunkPayload } from "../main/ipc-contract.js";
import { AudioCapture, AudioPlayback } from "./audio.js";

// window.jarvis выставлен preload (contextBridge).
declare global {
  interface Window {
    jarvis: JarvisBridge;
  }
}

const jarvis = window.jarvis;

// ── DOM-ссылки ─────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`нет элемента #${id}`);
  return el as T;
};

const orb = $("orb");
const stateLabel = $("stateLabel");
const transcriptEl = $("transcript");
const linkEl = $("link");
const cards = $("cards");

// панель задачи (§20)
const taskPanel = $("taskPanel");
const taskStateEl = $("taskState");
const taskSummaryEl = $("taskSummary");
const taskBarFill = $("taskBarFill");
const taskCancelBtn = $<HTMLButtonElement>("taskCancelBtn");
const taskPauseBtn = $<HTMLButtonElement>("taskPauseBtn");
const taskResumeBtn = $<HTMLButtonElement>("taskResumeBtn");

/** taskId активной задачи — для адресной отправки task.control (§20). */
let activeTaskId: string | null = null;

const inputForm = $<HTMLFormElement>("inputForm");
const textInput = $<HTMLInputElement>("textInput");

// модалка confirm
const confirmOverlay = $("confirmOverlay");
const confirmKind = $("confirmKind");
const confirmSummary = $("confirmSummary");
const revisionInput = $<HTMLInputElement>("revisionInput");
const approveBtn = $<HTMLButtonElement>("approveBtn");
const reviseBtn = $<HTMLButtonElement>("reviseBtn");
const denyBtn = $<HTMLButtonElement>("denyBtn");

let activeConfirm: ConfirmRequest | null = null;

// ── состояние / орб ────────────────────────────────────────────
function setOrbState(state: ClientState): void {
  orb.className = `orb orb--${state}`;
  stateLabel.textContent = state;
}

function setLink(link: LinkState): void {
  linkEl.textContent = link.online ? "online" : "offline";
  linkEl.className = `link ${link.online ? "link--on" : "link--off"}`;
}

// ── карточки ui.display (§21) ──────────────────────────────────
function addCard(card: DisplayCard): void {
  const el = document.createElement("div");
  el.className = "card";
  if (card.title) {
    const t = document.createElement("div");
    t.className = "card__title";
    t.textContent = card.title;
    el.appendChild(t);
  }
  const body = document.createElement("div");
  body.className = "card__body";
  // markdown показываем как текст (рендер MD — позже); textContent защищает от инъекций.
  body.textContent = card.markdown;
  el.appendChild(body);
  cards.appendChild(el);
  cards.scrollTop = cards.scrollHeight;
}

// ── панель задачи (§20) ────────────────────────────────────────
const TASK_STATE_RU: Record<TaskStatus["state"], string> = {
  queued: "в очереди",
  running: "выполняю",
  paused: "на паузе",
  waiting_confirm: "жду подтверждения",
  done: "готово",
  failed: "ошибка",
  cancelled: "отменено",
};

const TERMINAL_STATES: ReadonlySet<TaskStatus["state"]> = new Set(["done", "failed", "cancelled"]);
let taskHideTimer: ReturnType<typeof setTimeout> | null = null;

/** Отрисовать прогресс/состояние задачи и доступные кнопки управления (§20). */
function renderTaskStatus(s: TaskStatus): void {
  activeTaskId = s.taskId;
  if (taskHideTimer) {
    clearTimeout(taskHideTimer);
    taskHideTimer = null;
  }

  taskPanel.classList.remove("task--hidden");
  taskPanel.className = `task task--${s.state}`;
  taskStateEl.textContent = TASK_STATE_RU[s.state] ?? s.state;
  taskSummaryEl.textContent = s.summary ?? "";

  // Прогресс-бар: доля при известном total, иначе «неопределённый» (бегунок).
  if (s.stepsTotal && s.stepsTotal > 0) {
    const pct = Math.min(100, Math.round(((s.stepsDone ?? 0) / s.stepsTotal) * 100));
    taskBarFill.style.width = `${pct}%`;
    taskBarFill.classList.remove("task__bar-fill--indeterminate");
  } else {
    taskBarFill.style.width = "100%";
    taskBarFill.classList.add("task__bar-fill--indeterminate");
  }

  const terminal = TERMINAL_STATES.has(s.state);
  const paused = s.state === "paused";
  // На паузе предлагаем «Продолжить» вместо «Пауза»; в терминале прячем управление.
  taskCancelBtn.classList.toggle("task--hidden", terminal);
  taskPauseBtn.classList.toggle("task--hidden", terminal || paused);
  taskResumeBtn.classList.toggle("task--hidden", terminal || !paused);

  if (terminal) {
    activeTaskId = null;
    taskBarFill.classList.remove("task__bar-fill--indeterminate");
    // Показать итог несколько секунд, затем убрать панель.
    taskHideTimer = setTimeout(() => taskPanel.classList.add("task--hidden"), 4000);
  }
}

taskCancelBtn.addEventListener("click", () =>
  jarvis.sendTaskControl("cancel", activeTaskId ?? undefined),
);
taskPauseBtn.addEventListener("click", () =>
  jarvis.sendTaskControl("pause", activeTaskId ?? undefined),
);
taskResumeBtn.addEventListener("click", () =>
  jarvis.sendTaskControl("resume", activeTaskId ?? undefined),
);

// ── модалка подтверждения (§14) ────────────────────────────────
function openConfirm(req: ConfirmRequest): void {
  activeConfirm = req;
  confirmKind.textContent = req.kind; // send | order | irreversible
  confirmSummary.textContent = req.summary;
  revisionInput.value = "";
  confirmOverlay.classList.remove("overlay--hidden");
}

function closeConfirm(): void {
  activeConfirm = null;
  confirmOverlay.classList.add("overlay--hidden");
}

approveBtn.addEventListener("click", () => {
  if (!activeConfirm) return;
  jarvis.sendConfirmResult({ requestId: activeConfirm.requestId, approved: true });
  closeConfirm();
});

reviseBtn.addEventListener("click", () => {
  // §14 revise-петля: approved:false + revision -> сервер перегенерирует и пришлёт новый confirm.
  if (!activeConfirm) return;
  const revision = revisionInput.value.trim();
  jarvis.sendConfirmResult({
    requestId: activeConfirm.requestId,
    approved: false,
    revision: revision || undefined,
  });
  closeConfirm();
});

denyBtn.addEventListener("click", () => {
  if (!activeConfirm) return;
  jarvis.sendConfirmResult({ requestId: activeConfirm.requestId, approved: false });
  closeConfirm();
});

// ── поле ввода (M0) ────────────────────────────────────────────
inputForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  jarvis.submitText(text); // main: tier0 локально, иначе dev.text на сервер (§3, §17)
  textInput.value = "";
});

// ── подписки на события main ──────────────────────────────────
jarvis.onState((s: ClientState) => setOrbState(s));
jarvis.onLink((l: LinkState) => setLink(l));
jarvis.onTranscript((t: Transcript) => {
  transcriptEl.textContent = t.text;
});
jarvis.onNudge((n: ProactiveNudge) => {
  // Проактивная подсказка (§9): показываем карточкой (в проде ещё и проговаривается, если не истекла).
  if (Date.now() <= n.expiresAt) addCard({ title: "Подсказка", markdown: n.text });
});
jarvis.onConfirmRequest((r: ConfirmRequest) => openConfirm(r));
jarvis.onDisplay((c: DisplayCard) => addCard(c));
jarvis.onTaskStatus((s: TaskStatus) => renderTaskStatus(s));

// ── аудио (§3, §10): захват/воспроизведение в renderer (WebRTC AEC) ────────────
const playback = new AudioPlayback();
let capture: AudioCapture | null = null;
let micOpen = false;

jarvis.onSpeakChunk((c: SpeakChunkPayload) => playback.enqueue(c));
jarvis.onBargeIn(() => playback.stop());
jarvis.onMicState((open: boolean) => {
  micOpen = open;
  orb.classList.toggle("orb--mic", open);
});

/** Поднять захват (один раз). Кадры PCM уходят в main, где гейтятся (§0.6). */
async function ensureCapture(): Promise<void> {
  if (capture) return;
  capture = new AudioCapture((pcm) => jarvis.pushPcm(pcm));
  try {
    await capture.start();
  } catch {
    capture = null; // нет прав/устройства — остаётся текстовый ввод (M0)
  }
}

// Push-to-talk (§18): wake word «Джарвис» опционален; клик по орбу активирует микрофон.
orb.title = "Клик — говорить (push-to-talk). Повторный клик — mute.";
orb.addEventListener("click", () => {
  if (micOpen) {
    jarvis.mute();
    return;
  }
  void ensureCapture().then(() => jarvis.activate());
});

// ── настройки (ключи / устройства / контекст) ──
const settingsBtn = $("settingsBtn");
const settingsPanel = $("settingsPanel");
const settingsClose = $("settingsClose");
const settingsSave = $<HTMLButtonElement>("settingsSave");

settingsBtn.addEventListener("click", () => settingsPanel.classList.remove("settings--hidden"));
settingsClose.addEventListener("click", () => settingsPanel.classList.add("settings--hidden"));
settingsSave.addEventListener("click", () => {
  // TODO: персист ключей/контекста через preload → Electron safeStorage (§12/§13).
  settingsPanel.classList.add("settings--hidden");
});

// инициализация
setOrbState("idle");
setLink({ online: false });
