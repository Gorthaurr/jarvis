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
  DisplayCard,
  ChatMessage,
} from "@jarvis/protocol";
import type { JarvisBridge, LinkState, SpeakChunkPayload, KeyName, SettingsPatch } from "../main/ipc-contract.js";
import { AudioCapture, AudioPlayback } from "./audio.js";
import { $ } from "./dom.js";
import { buildWave } from "./wave.js";
import { initBillingPanel } from "./billing-panel.js";
import { initMonitorPanel } from "./monitor-panel.js";
import { initTaskPanel } from "./task-panel.js";
import { denyConfirm, initConfirmDialog, isConfirmOpen } from "./confirm-dialog.js";
import { cancelSkillModal, initSkillRecorder, isSkillOpen } from "./skill-recorder.js";
import { initVoiceEnrollment } from "./voice-enroll.js";

// window.jarvis выставлен preload (contextBridge).
declare global {
  interface Window {
    jarvis: JarvisBridge;
  }
}

const jarvis = window.jarvis;

// ── DOM-ссылки ─────────────────────────────────────────────────
const statusbar = $("statusbar");
const stateLabel = $("stateLabel");
const transcriptEl = $("transcript");
const linkEl = $("link");
const cards = $("cards");

// Центральный индикатор состояния (дизайн «Премиум-минимал»): гало + подпись + волна.
const hero = $("hero");
const heroLabel = $("heroLabel");

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
  // Центральный индикатор — та же машина состояний (гало/подпись/волна; кольцо скрыто в CSS).
  hero.className = `hero hero--${state}`;
  heroLabel.textContent = STATE_RU[state] ?? state;
}

function setLink(link: LinkState): void {
  linkEl.textContent = link.online ? "online" : "offline";
  linkEl.className = `link ${link.online ? "link--on" : "link--off"}`;
}

// ── карточки ui.display (§21) ──────────────────────────────────
// Дизайн «Премиум-минимал»: ambient-ассистент, НЕ чат-лог — показываем последний ответ под индикатором
// и убираем (эфемерно), чтобы экран оставался чистым (фокус на состоянии/голосе).
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
  body.textContent = card.markdown; // textContent — защита от инъекций
  el.appendChild(body);
  cards.appendChild(el);
  cardTimer = setTimeout(clearCards, 14_000); // эфемерно
}

initConfirmDialog(jarvis); // §14 модалка подтверждения — кнопки + клик по фону + onConfirmRequest внутри

// ── подписки на события main ──────────────────────────────────
jarvis.onState((s: ClientState) => setOrbState(s));
jarvis.onLink((l: LinkState) => {
  setLink(l);
  if (l.online) clearCards(); // на (пере)подключении убираем устаревшую карточку
});
jarvis.onTranscript((t: Transcript) => {
  transcriptEl.textContent = t.text;
});
jarvis.onNudge((n: ProactiveNudge) => {
  // Проактивная подсказка (§9): показываем карточкой (в проде ещё и проговаривается, если не истекла).
  if (Date.now() <= n.expiresAt) addCard({ title: "Подсказка", markdown: n.text });
});
jarvis.onDisplay((c: DisplayCard) => addCard(c));
initTaskPanel(jarvis); // §20 док задач — подписка onTaskStatus + чипы внутри

// ── аудио (§3, §10): захват/воспроизведение в renderer (WebRTC AEC) ────────────
// onActive → main: пока звук РЕАЛЬНО играет, перебивание (§10) остаётся включённым и в «хвосте»
// очереди (сервер уходит из speaking по концу синтеза, а плеер ещё доигрывает фразы).
const playback = new AudioPlayback(
  undefined,
  (active) => jarvis.setPlaybackActive(active),
  // Realtime инкремент 0: первый звук хода реально сыгран → наверх (сервер замыкает mouth-to-ear метрику).
  (gen, ts) => jarvis.audioPlayed?.(gen, ts),
);
let capture: AudioCapture | null = null;

// §22 mute озвучки: при выключенном звуке аудио-чанки НЕ проигрываем (Джарвис слышит и делает, но молча).
jarvis.onSpeakChunk((c: SpeakChunkPayload) => {
  if (!outputMuted) playback.enqueue(c);
});
jarvis.onBargeIn(() => playback.stop());
jarvis.onMicState((open: boolean) => statusbar.classList.toggle("statusbar--mic", open));

// ── §22 mute озвучки + режим чата ─────────────────────────────
const muteBtn = $("muteBtn");
const chatBtn = $("chatBtn");
const chatView = $("chatView");
const chatLog = $("chatLog");
const chatForm = $<HTMLFormElement>("chatForm");
const chatInput = $<HTMLInputElement>("chatInput");

let outputMuted = localStorage.getItem("jarvis.muted") === "1";
function applyMute(): void {
  muteBtn.classList.toggle("icon-btn--danger", outputMuted);
  muteBtn.title = outputMuted
    ? "Звук выключен — Джарвис слышит и делает, но молчит (нажмите, чтобы включить)"
    : "Выключить звук (Джарвис слышит и делает, но молча)";
  if (outputMuted) playback.stop(); // оборвать текущую озвучку
}
applyMute();
muteBtn.addEventListener("click", () => {
  outputMuted = !outputMuted;
  localStorage.setItem("jarvis.muted", outputMuted ? "1" : "0");
  applyMute();
});

let chatMode = false;
function setChatMode(on: boolean): void {
  chatMode = on;
  document.body.classList.toggle("chat-active", on);
  chatView.classList.toggle("chatview--hidden", !on);
  chatBtn.classList.toggle("icon-btn--active", on);
  if (on) chatInput.focus();
}
chatBtn.addEventListener("click", () => setChatMode(!chatMode));
// Явный выход из чата (кнопка «‹» в шапке) — раньше выйти было нечем (чат накрывал топбар).
$("chatBack").addEventListener("click", () => setChatMode(false));

// ── громкость голоса Джарвиса (ползунок в настройках) ──
const ttsVolume = $<HTMLInputElement>("ttsVolume");
const ttsVolumeVal = $("ttsVolumeVal");
function applyTtsVolume(pct: number): void {
  const v = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 100));
  playback.setVolume(v / 100);
  ttsVolume.value = String(v);
  ttsVolumeVal.textContent = `${v}%`;
}
applyTtsVolume(Number.parseInt(localStorage.getItem("jarvis.ttsVolume") ?? "100", 10));
ttsVolume.addEventListener("input", () => {
  const v = Number.parseInt(ttsVolume.value, 10) || 0;
  localStorage.setItem("jarvis.ttsVolume", String(v));
  applyTtsVolume(v);
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  jarvis.submitText(text); // dev.text путь — ответ текстом, без голоса
  chatInput.value = "";
  // пузырёк пользователя придёт назад через onChat (сервер шлёт role:user)
});

function chatBubble(role: "user" | "assistant", text: string): void {
  chatLog.querySelector(".chatlog__empty")?.remove();
  const b = document.createElement("div");
  b.className = `bubble bubble--${role}`;
  b.textContent = text;
  chatLog.appendChild(b);
  chatLog.scrollTop = chatLog.scrollHeight;
}

jarvis.onChat((m: ChatMessage) => {
  chatBubble(m.role, m.text); // лента в режиме чата (overlay с вводом)
  // mute + НЕ в чат-режиме: ответ Джарвиса показываем карточкой под индикатором (текст-фидбэк §22).
  if (m.role === "assistant" && outputMuted && !chatMode) addCard({ title: "Джарвис", markdown: m.text });
});

/** Поднять захват (один раз). Кадры PCM уходят в main, где гейтятся (§0.6). */
async function ensureCapture(): Promise<void> {
  if (capture) return;
  capture = new AudioCapture((pcm) => jarvis.pushPcm(pcm));
  try {
    await capture.start();
  } catch (e) {
    // НЕ глотаем: раньше тихий catch скрывал отказ микрофона → Джарвис «не слышал»
    // без единого следа. Логируем и показываем явный статус пользователю.
    // H18: при ЧАСТИЧНОМ провале start() (getUserMedia успел, ворклет — нет) MediaStream
    // оставался захваченным — микрофон «занят» до перезапуска. Добиваем перед сбросом ссылки.
    await capture.stop().catch(() => {});
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
const langSelect = $<HTMLSelectElement>("langSelect");
const contextInput = $<HTMLTextAreaElement>("contextInput");
const keyAnthropic = $<HTMLInputElement>("keyAnthropic");
const keyEleven = $<HTMLInputElement>("keyEleven");
const keyDeepgram = $<HTMLInputElement>("keyDeepgram");

// Поле ключа + его плейсхолдер «по умолчанию» (когда ключ ещё не задан).
const KEY_FIELDS: ReadonlyArray<{ input: HTMLInputElement; name: KeyName; ph: string }> = [
  { input: keyAnthropic, name: "anthropic", ph: "sk-…" },
  { input: keyEleven, name: "eleven", ph: "voiceId Джарвиса" },
  { input: keyDeepgram, name: "deepgram", ph: "резерв STT" },
];

/**
 * Подтянуть сохранённые настройки в форму. Секреты ключей в renderer НЕ возвращаются:
 * поля остаются пустыми, а плейсхолдер сообщает, что ключ уже сохранён.
 */
async function loadSettings(): Promise<void> {
  try {
    const s = await jarvis.getSettings();
    langSelect.value = s.language || "ru";
    contextInput.value = s.context || "";
    for (const f of KEY_FIELDS) {
      f.input.value = "";
      f.input.placeholder = s.keys[f.name] ? "сохранён — введите новый, чтобы заменить" : f.ph;
    }
  } catch (e) {
    console.error("настройки не загрузились:", e);
  }
}

settingsBtn.addEventListener("click", () => {
  settingsPanel.classList.remove("settings--hidden");
  void loadSettings(); // предзаполнить форму сохранёнными значениями
  jarvis.listMonitors(); // §6 подтянуть актуальные мониторы при открытии настроек
});
settingsClose.addEventListener("click", () => settingsPanel.classList.add("settings--hidden"));

// Сохранение настроек: реальный персист через main (safeStorage для ключей) + ЧЕСТНЫЙ фидбэк —
// никакого ложного «Готово»: текст кнопки отражает, что именно записано.
let saveResetTimer: ReturnType<typeof setTimeout> | null = null;
settingsSave.addEventListener("click", () => {
  if (saveResetTimer) {
    clearTimeout(saveResetTimer);
    saveResetTimer = null;
  }
  settingsSave.disabled = true;
  const keys: NonNullable<SettingsPatch["keys"]> = {};
  for (const f of KEY_FIELDS) {
    const v = f.input.value.trim();
    if (v) keys[f.name] = v; // пусто = не трогаем сохранённый ключ
  }
  jarvis
    .saveSettings({ language: langSelect.value, context: contextInput.value.trim(), keys })
    .then((res) => {
      if (!res.ok) {
        settingsSave.textContent = "Не удалось сохранить";
        settingsSave.disabled = false;
        return;
      }
      settingsSave.textContent = res.keysSkipped
        ? "Сохранено (ключи: нет шифрования ОС)"
        : "Сохранено ✓";
      saveResetTimer = setTimeout(() => {
        settingsSave.textContent = "Сохранить";
        settingsSave.disabled = false;
        settingsPanel.classList.add("settings--hidden");
      }, 1100);
    })
    .catch((e) => {
      console.error("сохранение настроек упало:", e);
      settingsSave.textContent = "Ошибка сохранения";
      settingsSave.disabled = false;
    });
});

// Вкладки настроек (Общее/Навыки/Ключи/Оплата): активная вкладка + показ её панели.
for (const tab of document.querySelectorAll<HTMLButtonElement>(".settab")) {
  tab.addEventListener("click", () => {
    const name = tab.dataset.tab;
    for (const t of document.querySelectorAll(".settab")) t.classList.toggle("settab--active", t === tab);
    for (const p of document.querySelectorAll<HTMLElement>(".settab-panel")) {
      p.classList.toggle("settab-panel--hidden", p.dataset.panel !== name);
    }
    // §6B/B5: при открытии вкладки «Оплата» запрашиваем свежий расход/лимиты у сервера.
    if (name === "billing") jarvis.requestUsage();
  });
}

initBillingPanel(jarvis); // §6B/B5 «Оплата» — onUsage + кнопка управления внутри

// ── запись навыка демонстрацией (§8) ───────────────────────────
initSkillRecorder(jarvis, () => settingsPanel.classList.add("settings--hidden")); // модалка + список + onSkill* внутри

// ── ESC закрывает верхний слой (a11y): сначала модалки, затем панель настроек ──
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (isConfirmOpen()) {
    denyConfirm(); // ESC на подтверждении = отклонить (безопасно)
  } else if (isSkillOpen()) {
    cancelSkillModal();
  } else if (!settingsPanel.classList.contains("settings--hidden")) {
    settingsClose.click();
  }
});

// ── верификация диктора (§3): запись голосовых отпечатков ──────
initVoiceEnrollment(jarvis); // §3 запись голоса — кнопка + прогресс + список голосов внутри

// ── Мониторы (§6 мультимонитор): ручной выбор рабочего монитора Джарвиса ──
initMonitorPanel(jarvis); // фабрика строк + onMonitors + listMonitors внутри

// инициализация — ambient (§3): Джарвис слушает СРАЗУ с запуска. Центр — гало+волна, состояние снизу.
setLink({ online: false });
setOrbState("listening");
buildWave();
void ensureCapture().then(() => jarvis.activate());
