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
import type { JarvisBridge, LinkState } from "../main/ipc-contract.js";

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
jarvis.onTaskStatus((s: TaskStatus) => {
  const steps = s.stepsTotal ? ` (${s.stepsDone ?? 0}/${s.stepsTotal})` : "";
  transcriptEl.textContent = `[${s.state}]${steps} ${s.summary ?? ""}`.trim();
});

// ── аудио-стаб (§3): права на микрофон, AEC включён ────────────
// TODO(M1): реальный стрим в LiveKit/WebRTC; здесь только проверка getUserMedia + AEC-флаг.
async function probeMic(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // Сразу отпускаем устройство — на M0 поток не используется.
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    // Нет прав/устройства — ок для M0 (вход текстом). В M1 это будет обязательным.
  }
}

// инициализация
setOrbState("idle");
setLink({ online: false });
void probeMic();
