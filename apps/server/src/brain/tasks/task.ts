/**
 * Модель долгой задачи (§20) — центральный контракт M8.
 *
 * Задача — это многошаговая работа агента (Excel на 40 шагов, заказ, серия действий),
 * у которой есть жизненный цикл, прогресс и итог. Голос/UI могут ею управлять:
 * «стоп»/«отмени»/«что делаешь»/«продолжи»/«потом доделай» (§20).
 *
 * Этот файл — только типы и чистые предикаты (без состояния и зависимостей), чтобы
 * менеджер задач, классификатор управления, нарратор и интеграция в agent-loop
 * собирались независимо вокруг одного контракта.
 */
import type { TaskState } from "@jarvis/protocol";

export type { TaskState };

/** Кооперативный флаг отмены: проверяется ПЕРЕД каждым шагом (отмена ≤1 шага, §20). */
export interface CancelFlag {
  cancelled: boolean;
}

/**
 * Канал ПРАВКИ НА ХОДУ (§20): пока задача идёт, пользователь говорит «нет, не то» / «добавь ещё» —
 * текст кладётся в `pending`, петля СЛИВАЕТ его ПЕРЕД очередным шагом и впрыскивает как указание
 * пользователя в диалог LLM, чтобы скорректировать текущие действия (не плодя вторую задачу).
 * Рантайм-объект (петля держит ссылку, как на CancelFlag) — в персист НЕ попадает.
 */
export interface SteerChannel {
  pending: string[];
}

/** Долгая задача (§20): цель, состояние, прогресс, итог. */
export interface Task {
  taskId: string;
  userId: string;
  sessionId: string;
  /** Что просили человеческими словами («сделай таблицу расходов») — полная формулировка. */
  goal: string;
  /** Краткая СУТЬ для UI-чипа («Таблица расходов») — производная от goal (deriveTaskTitle). */
  title: string;
  state: TaskState;
  /** Сколько шагов скилла/петли уже подтверждено. */
  stepsDone: number;
  /** Всего шагов — известно для скилла; undefined для open-ended LLM-петли. */
  stepsTotal?: number;
  /** unix ms старта (для порога нарративности >5 c, §20). */
  startedAt: number;
  /** unix ms завершения (done/failed/cancelled). */
  finishedAt?: number;
  /** Краткий итог по завершении (для отчёта голосом/пушем, §20). */
  resultSummary?: string;
  /** Причина последней ошибки (для errorReport: причина + одно следующее действие). */
  lastError?: string;
  /** Флаг отмены — менеджер выставляет cancelled=true, петля читает перед шагом. */
  cancel: CancelFlag;
  /** Канал правок на ходу (§20) — менеджер добавляет в pending, петля сливает перед шагом. */
  steer: SteerChannel;
}

/**
 * Форма задачи для персиста на диск (§5): всё, кроме рантайм-флага {@link CancelFlag}, который
 * имеет смысл лишь в живом процессе (петля держит ссылку на него). На восстановлении флаг создаётся
 * заново. См. {@link Task} и TaskManager.toJSON/restore.
 */
export type PersistedTask = Omit<Task, "cancel" | "steer">;

/**
 * Род команды управления задачей (§20). Ключевое различие §20: «стоп»/«заткнись»
 * рубит ТОЛЬКО озвучку (TTS), задача продолжается; «отмени» рубит САМУ задачу.
 */
export type TaskControlKind =
  | "cancel" // «отмени», «отставить» — прервать задачу (cancel-флаг)
  | "stop_tts" // «стоп», «заткнись», «тихо» — оборвать TTS, задача живёт
  | "pause" // «потом доделаешь», «пауза» — приостановить с возможностью resume
  | "resume" // «продолжи», «дальше» — возобновить с текущего шага
  | "status" // «что делаешь», «как там» — отчёт о текущем прогрессе
  | "none"; // не команда управления — обычная реплика/контент

/** Состояния, в которых задача ещё «живёт» (можно отменить/паузить/возобновить). */
export const ACTIVE_TASK_STATES: readonly TaskState[] = [
  "queued",
  "running",
  "paused",
  "waiting_confirm",
];

/** Терминальна ли задача (дальше состояние не меняется). */
export function isTerminalState(state: TaskState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}

/** Активна ли задача (не достигла терминального состояния). */
export function isActiveState(state: TaskState): boolean {
  return ACTIVE_TASK_STATES.includes(state);
}

/**
 * §20: «содержательная» ли задача — сделала ли хоть один шаг с инструментом (stepsDone>0).
 * Каждый ход агента создаёт Task (для управления/чипа), но ПУСТАЯ болтовня («привет») инструментов не
 * вызывает → stepsDone остаётся 0. Такие псевдо-задачи НЕ должны всплывать в «сделал?» (иначе история
 * замусоривается «✓ Привет — Здравствуйте, сэр» и раздувается хвост промпта). Зеркалит гейт `shown`
 * (панель/чип показываем только на реальном tool-use). Применяется в recentTerminal.
 */
export function isSubstantiveTask(t: Task): boolean {
  return t.stepsDone > 0;
}

/** Порог нарративности §20: задачи длиннее этого анонсируются и резюмируются. */
export const NARRATE_THRESHOLD_MS = 5_000;

/** Максимальная длина заголовка-чипа (символов) — дальше обрезаем по слову с «…». */
const TITLE_MAX = 48;
/** Ведущие вводные/служебные слова, которые не несут сути для заголовка чипа. */
const TITLE_LEAD_FILLER = [
  "пожалуйста", "слушай", "слушай-ка", "так", "ну", "давай", "давай-ка", "а", "и",
  "можешь", "можешь ли", "сможешь", "будь добр", "будь любезен", "сэр",
];

/**
 * Краткая СУТЬ задачи для UI-чипа из человеческой формулировки цели (§20). Чистая функция:
 * берём первую фразу (до .?!/перевода строки), срезаем ведущие вводные слова, схлопываем
 * пробелы, режем по границе слова до TITLE_MAX с «…», первую букву — в верхний регистр.
 * Это НЕ переписывание смысла (без LLM), а «причёсанная» исходная фраза вместо сырого потока.
 */
export function deriveTaskTitle(goal: string): string {
  const firstSentence = (goal.split(/[.!?\n]/)[0] ?? goal).trim();
  let s = firstSentence.replace(/\s+/g, " ").trim();
  // Срезаем ведущие вводные слова (по одному, пока совпадают), сохраняя суть.
  let changed = true;
  while (changed && s.length > 0) {
    changed = false;
    for (const f of TITLE_LEAD_FILLER) {
      const re = new RegExp(`^${f}[\\s,]+`, "iu");
      if (re.test(s)) {
        s = s.replace(re, "").trim();
        changed = true;
        break;
      }
    }
  }
  if (s.length === 0) s = firstSentence || goal.trim();
  if (s.length > TITLE_MAX) {
    const cut = s.slice(0, TITLE_MAX);
    const lastSpace = cut.lastIndexOf(" ");
    s = `${(lastSpace > TITLE_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Относительное время по-русски для блока «недавние задачи» («только что» / «N мин назад» / «N ч назад»). */
function relativeTimeRu(deltaMs: number): string {
  if (deltaMs < 0) deltaMs = 0;
  const min = Math.floor(deltaMs / 60_000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  return `${d} дн назад`;
}

/** Глиф состояния терминальной задачи для блока «недавние задачи» (читается голосом-агентом). */
function stateGlyph(state: TaskState): string {
  if (state === "done") return "✓";
  if (state === "cancelled") return "⊘";
  return "✗"; // failed
}

/** Максимум символов résumé/ошибки в строке «недавней задачи» — не раздуваем некешируемый хвост промпта. */
const RECENT_SUMMARY_MAX = 160;

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * §20: блок «недавно выполненные задачи» для системного промпта — чтобы Джарвис ОСОЗНАННО отвечал
 * на «сделал?»/«что делал?»/«получилось?» из ДОЛГОВЕЧНОГО реестра задач, а не из вытесняемого окна
 * реплик. Чистая функция (now инъецируется). Пусто (""), если задач нет — тогда блок не добавляется.
 * Идёт в НЕкешируемый динамический хвост промпта (renderDynamic) — не ломает prompt-кеш §15.
 */
export function formatRecentTasks(tasks: readonly Task[], now: number): string {
  if (tasks.length === 0) return "";
  const lines = tasks.map((t) => {
    const when = relativeTimeRu(now - (t.finishedAt ?? t.startedAt));
    const detail =
      t.state === "done"
        ? t.resultSummary
          ? `: ${clip(t.resultSummary, RECENT_SUMMARY_MAX)}`
          : ""
        : t.state === "failed"
          ? `: не вышло${t.lastError ? ` — ${clip(t.lastError, RECENT_SUMMARY_MAX)}` : ""}`
          : ""; // cancelled — без детали
    return `- ${stateGlyph(t.state)} ${t.title} — ${when}${detail}`;
  });
  return [
    "# Недавно выполненные задачи (§20)",
    "Отвечай по ним на «сделал?», «что делал?», «получилось?» — это твоя фактическая история, а не догадка.",
    "Не упоминай их без повода (только когда спрашивают об итогах/статусе).",
    ...lines,
  ].join("\n");
}

/**
 * §20: блок «задачи В РАБОТЕ прямо сейчас» — чтобы на «что делаешь?»/«сделал?»/«готово?» во время
 * фоновой работы Джарвис честно сказал «ещё в работе», а НЕ «ничего не делаю» (баг: фоновая задача в
 * полёте не попадала в контекст → отрицал, что что-то делает, и пересчитывал заново). Чистая функция.
 * Пусто (""), если активных нет. Идёт в НЕкешируемый хвост промпта (renderDynamic), кеш §15 не страдает.
 */
export function formatActiveTasks(tasks: readonly Task[], now: number): string {
  if (tasks.length === 0) return "";
  const lines = tasks.map((t) => {
    const when = relativeTimeRu(now - t.startedAt);
    const step = t.stepsTotal ? `, шаг ${t.stepsDone}/${t.stepsTotal}` : "";
    return `- ⏳ ${t.title} — начал ${when}${step}`;
  });
  return [
    "# Задачи В РАБОТЕ прямо сейчас (§20)",
    "Если спрашивают «что делаешь?»/«сделал?»/«готово?» по этим — честно: ещё в работе (не говори «ничего не делаю» и не начинай заново).",
    ...lines,
  ].join("\n");
}

/** Дружелюбные имена популярных сервисов по хосту — для заголовка-чипа «по смыслу». */
const SERVICE_NAMES: Record<string, string> = {
  "music.yandex.ru": "Яндекс Музыка",
  "music.yandex.com": "Яндекс Музыка",
  "youtube.com": "YouTube",
  "youtu.be": "YouTube",
  "yandex.ru": "Яндекс",
  "ya.ru": "Яндекс",
  "passport.yandex.ru": "Яндекс ID",
  "vk.com": "ВКонтакте",
  "web.telegram.org": "Telegram",
  "t.me": "Telegram",
  "google.com": "Google",
  "mail.google.com": "Gmail",
  "calendar.google.com": "Google Календарь",
  "wildberries.ru": "Wildberries",
  "ozon.ru": "Ozon",
  "open.spotify.com": "Spotify",
  "spotify.com": "Spotify",
  "twitch.tv": "Twitch",
};

function hostName(url: string): string {
  let h = "";
  try {
    h = new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    h = url.toLowerCase();
  }
  const noWww = h.replace(/^www\./, "");
  return SERVICE_NAMES[h] ?? SERVICE_NAMES[noWww] ?? noWww ?? url;
}

function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Заголовок-чип ПО СМЫСЛУ ДЕЙСТВИЯ (§20): из первого реального tool-вызова задачи, а не из сырой
 * фразы пользователя (которую STT часто коверкает — «Ключи Яндекс»). Чистая функция, без LLM —
 * меняем чип на «что делаю» (Яндекс Музыка / Запуск OBS / Поиск: погода). null = инструмент не несёт
 * сути задачи (чтение/скрин/память/клик) — тогда заголовок ставит следующий значимый вызов.
 */
export function actionTitle(toolName: string, input: Record<string, unknown>): string | null {
  const s = (v: unknown): string => String(v ?? "").trim();
  switch (toolName) {
    case "browser_open":
    case "web_open": {
      const u = s(input.url);
      return u ? hostName(u) : null;
    }
    case "browser_act": {
      const map: Record<string, string> = {
        play: "Воспроизведение",
        pause: "Пауза",
        next: "Следующий трек",
        prev: "Предыдущий трек",
      };
      return map[s(input.intent)] ?? null; // click/type/scroll — не суть задачи
    }
    case "app_launch": {
      const a = s(input.app);
      return a ? `Запуск: ${cap(a)}` : null;
    }
    case "web_search": {
      const q = s(input.query);
      return q ? `Поиск: ${q.length > 40 ? `${q.slice(0, 40)}…` : q}` : null;
    }
    case "office_excel":
      return "Excel";
    case "office_word":
      return "Word";
    case "fs_write":
    case "fs_edit": {
      const p = s(input.path);
      return p ? `Файл: ${baseName(p)}` : null;
    }
    case "code_run":
      return "Запуск кода";
    case "telegram_send":
    case "message_send":
      return "Сообщение в Telegram";
    case "obs_request":
      return "OBS";
    case "system_media":
      return "Управление музыкой";
    case "system_volume":
      return "Громкость";
    default:
      return null; // screen_capture / browser_read / memory_* / skill_* / ui_ground / input_* — не суть
  }
}
