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

const statusbar = $("statusbar");
const stateLabel = $("stateLabel");
const transcriptEl = $("transcript");
const linkEl = $("link");
const cards = $("cards");

// Центральный пассивный индикатор состояния (Amnezia-стиль). Зеркалит то же
// состояние, что и statusbar (idle/listening/thinking/speaking).
const hero = $("hero");
const heroLabel = $("heroLabel");

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
const STATE_RU: Record<ClientState, string> = {
  idle: "слушаю",
  listening: "слушаю",
  thinking: "думаю",
  speaking: "говорю",
};
let currentState: ClientState = "listening"; // для цвета шкалы голоса
function setOrbState(state: ClientState): void {
  currentState = state;
  statusbar.className = `statusbar statusbar--${state}`;
  stateLabel.textContent = STATE_RU[state] ?? state;
  // Центральный индикатор — та же машина состояний (§3, пассивный, без клика).
  hero.className = `hero hero--${state}`;
  heroLabel.textContent = STATE_RU[state] ?? state;
}

function setLink(link: LinkState): void {
  linkEl.textContent = link.online ? "online" : "offline";
  linkEl.className = `link ${link.online ? "link--on" : "link--off"}`;
}

// ── карточки ui.display (§21) ──────────────────────────────────
// Ambient-ассистент, НЕ чат-лог: НЕ копим карточки (раньше приветствие плодило
// дубли на каждом переподключении). Показываем только последнюю и убираем её.
let cardTimer: ReturnType<typeof setTimeout> | null = null;
function clearCards(): void {
  cards.innerHTML = "";
  if (cardTimer) {
    clearTimeout(cardTimer);
    cardTimer = null;
  }
}
function addCard(card: DisplayCard): void {
  clearCards();
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
  cardTimer = setTimeout(clearCards, 12_000); // эфемерно
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

// ── подписки на события main ──────────────────────────────────
jarvis.onState((s: ClientState) => setOrbState(s));
jarvis.onLink((l: LinkState) => {
  setLink(l);
  if (l.online) clearCards(); // на (пере)подключении убрать накопившиеся карточки
});
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

jarvis.onSpeakChunk((c: SpeakChunkPayload) => playback.enqueue(c));
jarvis.onBargeIn(() => playback.stop());
jarvis.onMicState((open: boolean) => statusbar.classList.toggle("statusbar--mic", open));

/** Поднять захват (один раз). Кадры PCM уходят в main, где гейтятся (§0.6). */
async function ensureCapture(): Promise<void> {
  if (capture) return;
  capture = new AudioCapture((pcm) => jarvis.pushPcm(pcm));
  try {
    await capture.start();
  } catch (e) {
    // НЕ глотаем: раньше тихий catch скрывал отказ микрофона → Джарвис «не слышал»
    // без единого следа. Логируем и показываем явный статус пользователю.
    capture = null;
    console.error("микрофон недоступен:", e);
    transcriptEl.textContent = "Нет доступа к микрофону — проверьте разрешение в Windows.";
  }
}

// Орб — пассивный индикатор состояния. Активация НЕ по клику: Джарвис слушает
// сам с запуска (ambient, §3). Микрофон поднимается в инициализации ниже.

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

// ── запись навыка демонстрацией (§8) ───────────────────────────
const makeSkillBtn = $<HTMLButtonElement>("makeSkillBtn");
const skillOverlay = $("skillOverlay");
const skillSetup = $("skillSetup");
const skillRecording = $("skillRecording");
const skillName = $<HTMLInputElement>("skillName");
const skillCountEl = $("skillCount");
const skillLastEl = $("skillLast");
const skillStartBtn = $<HTMLButtonElement>("skillStartBtn");
const skillDoneBtn = $<HTMLButtonElement>("skillDoneBtn");
const skillCancelBtn = $<HTMLButtonElement>("skillCancelBtn");
const skillList = $("skillList");

let recording = false;

/** Сбросить модалку записи в исходный (до старта) вид. */
function resetSkillModal(): void {
  recording = false;
  skillSetup.classList.remove("overlay--hidden");
  skillRecording.classList.add("overlay--hidden");
  skillStartBtn.classList.remove("overlay--hidden");
  skillDoneBtn.classList.add("overlay--hidden");
  skillCountEl.textContent = "0";
  skillLastEl.textContent = "";
}

function openSkillModal(): void {
  resetSkillModal();
  skillName.value = "";
  settingsPanel.classList.add("settings--hidden"); // не перекрывать модалкой
  skillOverlay.classList.remove("overlay--hidden");
}

function closeSkillModal(): void {
  skillOverlay.classList.add("overlay--hidden");
  resetSkillModal();
}

makeSkillBtn.addEventListener("click", openSkillModal);

skillStartBtn.addEventListener("click", () => {
  // Сворачиваем окно Джарвиса, чтобы пользователь показывал задачу в своих приложениях.
  jarvis.startSkill(skillName.value);
});

skillDoneBtn.addEventListener("click", () => {
  jarvis.stopSkill();
  closeSkillModal();
});

skillCancelBtn.addEventListener("click", () => {
  if (recording) jarvis.cancelSkill();
  closeSkillModal();
});

// Состояние записи из main: переключаем вид и обновляем счётчик.
jarvis.onSkillState((s) => {
  if (s.unavailable) {
    skillLastEl.textContent = "Запись недоступна — не запущен системный модуль (sidecar).";
    return;
  }
  recording = s.recording;
  if (s.recording) {
    skillSetup.classList.add("overlay--hidden");
    skillRecording.classList.remove("overlay--hidden");
    skillStartBtn.classList.add("overlay--hidden");
    skillDoneBtn.classList.remove("overlay--hidden");
  }
  skillCountEl.textContent = String(s.count);
  if (s.last) skillLastEl.textContent = s.last;
});

// Навык записан/прислан сервером — добавляем строку с кнопкой повтора.
jarvis.onSkillSaved((s) => {
  const empty = skillList.querySelector(".skill-list__empty");
  if (empty) empty.remove();
  // не дублируем при повторной записи того же id
  const existing = skillList.querySelector(`[data-skill-id="${s.id}"]`);
  existing?.remove();

  const li = document.createElement("li");
  li.className = "skill";
  li.dataset.skillId = s.id;

  const meta = document.createElement("div");
  meta.className = "skill__meta";
  const nameEl = document.createElement("span");
  nameEl.className = "skill__name";
  nameEl.textContent = s.name;
  const sub = document.createElement("span");
  sub.className = "skill__sub";
  sub.textContent = `${s.steps.length} шагов${s.needsReview ? " · нужно ревью" : ""}`;
  meta.appendChild(nameEl);
  meta.appendChild(sub);

  const play = document.createElement("button");
  play.className = "btn btn--ok btn--sm";
  play.type = "button";
  play.textContent = "▶ Повторить";
  play.addEventListener("click", () => jarvis.runSkill(s.id));

  li.appendChild(meta);
  li.appendChild(play);
  skillList.appendChild(li);
});

// ── живая шкала голоса (колебания речи) ─────────────────────────
const waveCanvas = document.getElementById("wave") as HTMLCanvasElement | null;
function startWaveform(analyser: AnalyserNode): void {
  if (!waveCanvas) return;
  const cctx = waveCanvas.getContext("2d");
  if (!cctx) return;
  const buf = new Uint8Array(analyser.frequencyBinCount);
  const dpr = window.devicePixelRatio || 1;
  const fit = (): void => {
    waveCanvas.width = Math.max(1, Math.round(waveCanvas.clientWidth * dpr));
    waveCanvas.height = Math.max(1, Math.round(waveCanvas.clientHeight * dpr));
  };
  fit();
  window.addEventListener("resize", fit);
  // Эквалайзер-столбики (как в макете «Премиум-минимал»): циан со свечением, симметрично
  // от центра, мягкое сглаживание во времени. Голос даёт энергию в нижне-средних частотах —
  // верхние (почти всегда пустые) бины отрезаем, чтобы столбики «жили» по всей ширине.
  const BARS = 40;
  const levels = new Float32Array(BARS); // сглаженные высоты (0..1) — чтобы не «дёргалось»
  const draw = (): void => {
    requestAnimationFrame(draw);
    analyser.getByteFrequencyData(buf);
    const w = waveCanvas.width;
    const h = waveCanvas.height;
    cctx.clearRect(0, 0, w, h);
    const gap = 2 * dpr;
    const barW = Math.max(1.5 * dpr, (w - gap * (BARS - 1)) / BARS);
    const mid = h / 2;
    const usable = Math.max(1, Math.floor(buf.length * 0.6)); // отрезаем пустой верх спектра
    cctx.fillStyle = "#5ed6ff";
    cctx.shadowColor = "rgba(94, 214, 255, 0.75)";
    cctx.shadowBlur = 7 * dpr;
    for (let i = 0; i < BARS; i += 1) {
      const a = Math.floor((i / BARS) * usable);
      const b = Math.max(a + 1, Math.floor(((i + 1) / BARS) * usable));
      let sum = 0;
      for (let j = a; j < b; j += 1) sum += buf[j]!;
      const amp = sum / (b - a) / 255; // 0..1
      // экспоненциальное сглаживание: вверх быстро, вниз плавно (живой, но не нервный эквалайзер)
      const prev = levels[i]!;
      levels[i] = amp > prev ? amp : prev * 0.82 + amp * 0.18;
      const barH = Math.max(2 * dpr, levels[i]! * h * 0.94);
      const x = i * (barW + gap);
      cctx.beginPath();
      cctx.roundRect(x, mid - barH / 2, barW, barH, Math.min(barW / 2, 2 * dpr));
      cctx.fill();
    }
  };
  draw();
}

// инициализация — ambient (§3): Джарвис слушает СРАЗУ с запуска, без клика по орбу.
setLink({ online: false });
setOrbState("listening");
void ensureCapture().then(() => {
  jarvis.activate();
  if (capture?.analyser) startWaveform(capture.analyser);
});
