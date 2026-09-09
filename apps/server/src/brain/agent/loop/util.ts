// W3 «Петля»: общие хелперы и константы петли (вынесены из agent/index.ts дословно — комментарии
// у них и есть спецификация). Импортируются фазами loop/*.ts и самим index.ts.
import type { ReplySink } from "../types.js";
import type { SkillStep, TaskStatus } from "@jarvis/protocol";
import { REPLAY_TYPE_MAX_CHARS, SKILL_EXECUTE_SERVER_TIMEOUT_MS } from "@jarvis/protocol";
import { type Logger, createLogger, envInt, sleep } from "@jarvis/shared";
import type { Session } from "../../../gateway/session.js";
import type { LlmMessage } from "../../../integrations/llm.js";
import { browserUrlBlocked } from "../../tools/dispatch-util.js";
import type { RecalledSkill } from "../../../memory/skills.js";
import { verbalize } from "../../verbalize/index.js";
import { type Task } from "../../tasks/task.js";
import { SessionWarmth } from "../warmth.js";

export const log: Logger = createLogger("agent");

/** Тёплость сессий по умолчанию (§15), если не инъектирован общий через deps. */
export const sharedWarmth = new SessionWarmth();

/**
 * §20 «осознание задач»: окно, за которое недавние терминальные задачи инжектятся в контекст для
 * ответа на «сделал?». 6 ч ≈ retention реестра по умолчанию (JARVIS_TASK_RETENTION_MS) — дальше задачи
 * и так вычищены sweep'ом из памяти. Не делаем больше, чтобы не таскать вчерашние задачи в каждый ход.
 */
export const RECENT_TASKS_WINDOW_MS = 6 * 60 * 60_000;

/**
 * Окно §14-подтверждения (Ф0 пульта). Было зашито литералом 60_000 — это 25% потолка задачи
 * (JARVIS_TASK_MAX_MS, деф 240с), и всё это время петля держала слот параллельности и аренду ввода.
 * Кламп [10с, 5мин]: ниже владелец физически не успеет прочитать модалку, выше — задача умрёт по
 * потолку раньше, чем истечёт окно (и вопрос окажется бессмысленным).
 */
export function confirmWindowMs(): number {
  return Math.min(300_000, Math.max(10_000, envInt("JARVIS_CONFIRM_WINDOW_MS", 60_000)));
}

/** Есть ли в строке произносимое содержимое (буква/цифра) — иначе в TTS не отдаём. */
export const HAS_VOICE = /[\p{L}\p{N}]/u;

/** Вербализовать сырое предложение (§21) и отдать в sink, если есть что произносить. */
export function emitSentence(sink: ReplySink, raw: string): void {
  const v = verbalize(raw);
  if (v && HAS_VOICE.test(v)) sink.sentence(v);
}

/**
 * Биржевые инструменты (§трейдинг): их использование переводит ход на МАКС модель (Opus), без тиров —
 * на бирже важна обдуманность. Страховка к роутеру `looksLikeTrading` (см. agent-loop).
 */
export const TRADING_TOOLS: ReadonlySet<string> = new Set([
  "market_quote",
  "market_candles",
  "market_analyze",
  "tinkoff_portfolio",
  "trade_predict",
  "trade_winrate",
  "trade_predictions",
]);

/**
 * §Волна2 (2.2): ЯВНЫЙ allowlist инструментов, которые можно диспатчить параллельно внутри одного
 * раунда — только чистые чтения без durable-записи и без GUI. «Нейтральность» для verify-петли
 * (error-voice) — НЕ то же самое: memory_write/skill_save/set_reminder нейтральны для экрана, но
 * пишут состояние → параллелить их с чтениями того же состояния нельзя (ревью Волны 2).
 */
export const PARALLEL_READONLY_TOOLS: ReadonlySet<string> = new Set([
  "web_search", "web_fetch", "memory_search", "knowledge_consult",
  "fs_read", "fs_list", "fs_search", "telegram_read",
  "market_quote", "market_candles", "market_analyze", "market_backtest", "market_news",
  "tinkoff_portfolio", "trade_winrate", "trade_predictions",
  "monitor_list", "window_list", "screen_probe", "browser_tabs",
  "skill_list", "tool_list", "list_reminders", "watch_list", "obligation_list",
  "calendar_read", "mail_read",
  // Волна I: чтение своего кода/телеметрии — чистые чтения с диска, параллелятся безопасно
  // (self_patch сюда НЕ входит: он меняет ветку и гоняет тесты — строго последовательно).
  "self_weaknesses", "self_code_search", "self_code_read",
  "file_view", // §3.9: чтение картинки/страницы PDF с диска — чистое чтение, GUI не трогает
  "job_status",
]);

/**
 * Консервативная оценка токенов блоков tool_result — для PROACTIVE контекст-гарда (аудит 2026-07-20).
 * Точный счёт не нужен: цель — спроектировать прирост промпта, чтобы свернуться ДО пробоя окна (400).
 * ЗАНИЖЕНИЕ — единственное ОПАСНОЕ направление (недооценил → 400 без свёртка); ПЕРЕОЦЕНКА бесплатна
 * (максимум пара ранних честных свёртков у самого потолка, коротких задач не касается). Поэтому делитель
 * КОНСЕРВАТИВНЫЙ: длина/2.5 (адверс-ревью F8). У RU-ассистента доминирующий контент tool_result'ов —
 * КИРИЛЛИЦА (web_fetch/browser_read капнуты 8000 симв, преимущественно русский текст), а её Claude
 * токенизирует плотнее латиницы (~2.5 симв/ток против ~4). Делитель 3.5 (латинская калибровка) занижал
 * бы именно доминирующий язык — там, где занижать нельзя. 2.5 над-оценивает латиницу (безопасно), покрывает
 * кириллицу. Картинка (скрин) ≈ 2000 ток. Чистая функция (экспорт для юнит-теста); string- и блочный content.
 */
export const CHARS_PER_TOKEN = 2.5;
export function estimateResultTokens(blocks: ReadonlyArray<Record<string, unknown>>): number {
  let t = 0;
  for (const b of blocks) {
    const c = b?.content;
    if (typeof c === "string") {
      t += Math.ceil(c.length / CHARS_PER_TOKEN);
    } else if (Array.isArray(c)) {
      for (const part of c as Array<Record<string, unknown>>) {
        if (part?.type === "text" && typeof part.text === "string") t += Math.ceil(part.text.length / CHARS_PER_TOKEN);
        else if (part?.type === "image") t += 2000; // скрин ~1.5-2K токенов
      }
    }
  }
  return t;
}

/**
 * Волна C: сколько ПОСЛЕДНИХ раундов с наблюдениями свёртка не трогает. 2 — компромисс: свежее
 * состояние экрана/страницы (на него опирается ближайший ход и сверка слепого действия) остаётся
 * целым, а всё, что старше, перечитываемо инструментом.
 */
export const MASK_KEEP_RECENT_ROUNDS = 2;
/** Делитель для ОСВОБОЖДЁННЫХ символов: латинский (скупой) — см. комментарий у freedTokens. */
export const CHARS_PER_TOKEN_CONSERVATIVE_FREE = 4;
/** Аварийный выключатель свёртки: вернуться к прежнему «упёрлись в потолок — задача мертва». */
export const maskObservationsOn = (): boolean => process.env.JARVIS_MASK_OBSERVATIONS !== "0";

/** Инструменты, не предлагаемые модели в диалоге (инициируются иначе / не в концепции).
 *  demo_record — запись навыка стартует кнопкой «Сделать скилл» в UI, не моделью.
 *  message_send/order_place — это userbot/mock-API (реально не шлёт/не заказывает) и НЕ в
 *  концепции «тонкий клиент». Убраны, чтобы Джарвис не хватался за фейковый шорткат, а делал
 *  по-человечески через интерфейс: открыл мессенджер (web.telegram.org/приложение) → нашёл
 *  контакт → впечатал → отправил (browser_act, ui_invoke, input_type), как в персоне (§6, §8).
 *  skill_execute ПРЕДЛАГАЕТСЯ (§8): модель запускает выученные навыки по id. */
export const EXCLUDED_TOOLS = new Set([
  "demo_record",
  "message_send",
  "order_place",
  // ЗРЕНИЕ: `screen_capture` теперь РЕАЛЬНЫЙ (Electron desktopCapturer → image-блок, screen.ts +
  // dispatch.lookAtScreen) — он в наборе (раньше был исключён как заглушка M3).
]);

/**
 * Дописать замечание в ХВОСТ последнего user-сообщения (steer-механика §20): convo обязан
 * оканчиваться пользователем, второй user-ход подряд не плодим (Opus не принимает префилл).
 */
export function appendUserNote(convo: LlmMessage[], note: string): void {
  const last = convo[convo.length - 1];
  if (last && last.role === "user") {
    if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }, { type: "text", text: note }];
    else last.content.push({ type: "text", text: note });
  } else {
    convo.push({ role: "user", content: note });
  }
}

/** Краткое текущее «ЧЧ:ММ» в поясе пользователя — для live-рефреша Б3 (renderNow заморожен на весь ход). */
export function shortTime(timezone?: string): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", ...(timezone ? { timeZone: timezone } : {}) }).format(new Date());
  } catch {
    return new Date().toISOString().slice(11, 16);
  }
}

/** Маркер Б3-впрыска снимка ПК. */
export const LIVE_SNAPSHOT_MARKER = "🖥️ ОБСТАНОВКА НА ПК ОБНОВИЛАСЬ";
/** §режим выделения: владелец показал/убрал область ПОСРЕДИ задачи — врезка петли, НЕ его реплика. */
export const SELECTION_NOTE_MARKER = "🖼️ ВЫДЕЛЕНИЕ НА ЭКРАНЕ ИЗМЕНИЛОСЬ";

/**
 * Ревью Волны 3 (#5): схемы URI, безопасные для ДЕТЕРМИНИРОВАННОГО реплея app.launch/browser.open
 * (клиент шелл-открывает их без модели в петле). Всё остальное со схемой (file:/ms-msdt:/search-ms:/
 * ms-settings:/shell:…) — потенциальный локальный эксплойт из отравленного навыка → реплей отменяем,
 * задача идёт обычной петлёй. Голое имя приложения (без схемы) — ок.
 *
 * ⚠️ ГРАНИЦА ЭТОГО РУБЕЖА (честно, адверс-ревью 2026-09-01): он закрывает ТОЛЬКО слепой реплей навыка.
 * ПРЯМОЙ вызов `app_launch` фильтра схем НЕ имеет (в URL_NAV_TOOLS его нет), и рецепты каналов
 * (`app-channels.ts`) СОЗНАТЕЛЬНО учат модель открывать через него ms-settings:/steam:/tg:/vscode:/
 * com.epicgames.launcher: — browser_open такие схемы отвергает по построению. Значит «обычная петля»
 * тут НЕ означает «через гардированный browser_open»: у прямого пути гарда нет. Сузить его до
 * allowlist нельзя без решения владельца — allowlist сломает эти самые рецепты.
 */
export const REPLAY_SAFE_URI_SCHEMES = new Set(["http", "https", "steam", "mailto", "tel"]);

/** URI-значение шага небезопасно для слепого реплея: неизвестная схема ИЛИ приватный/loopback http(s). */
export function replayUriUnsafe(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(value.trim());
  if (!m) return false; // нет схемы — голое имя приложения/файла, не URI-хэндлер
  const scheme = m[1]!.toLowerCase();
  if (!REPLAY_SAFE_URI_SCHEMES.has(scheme)) return true; // file/ms-msdt/search-ms/… → не реплеим вслепую
  if (scheme === "http" || scheme === "https") return browserUrlBlocked(value); // приватный/loopback → блок
  return false;
}

/**
 * Ревью Волны 3 (#2): серверный потолок ожидания реплей-макроса. ДОЛЖЕН быть строго больше клиентского
 * бюджета runSkill (SKILL_REPLAY_BUDGET_MS в actuators, деф 90с) + сетевой запас — тогда клиент ВСЕГДА
 * успевает вернуть честный результат до таймаута, и «два писателя в GUI» невозможны.
 * Ревью фиксов (#12): константа общая в @jarvis/protocol — тот же потолок у skill_execute/input_batch.
 */
export const REPLAY_MACRO_SERVER_TIMEOUT_MS = SKILL_EXECUTE_SERVER_TIMEOUT_MS;

/** Клавиша-«отправка» (Enter/Return, в т.ч. с Ctrl) — коммит сообщения/формы. Ревью р1 #16: SHIFT+Enter
 *  в мессенджерах — ПЕРЕНОС СТРОКИ, не отправка; считать его коммитом = сжечь пару «набрал→закоммитил»
 *  досрочно и пропустить настоящий Enter без сверки. Модификатор shift исключаем (ctrl+enter оставляем). */
export function isSendKey(combo: unknown): boolean {
  if (typeof combo !== "string") return false;
  const parts = combo.toLowerCase().split("+").map((p) => p.trim());
  const last = parts[parts.length - 1] ?? "";
  if (last !== "enter" && last !== "return") return false;
  return !parts.includes("shift"); // shift+enter = перенос строки, НЕ коммит
}

/** Вставка из буфера (Ctrl+V/Shift+Insert) — тоже ВВОД текста (ревью р1 #9): взводит «набрал». */
export function isPasteCombo(combo: unknown): boolean {
  if (typeof combo !== "string") return false;
  const c = combo.toLowerCase().replace(/\s+/g, "");
  return c === "ctrl+v" || c === "cmd+v" || c === "shift+insert";
}

/** Шаг берста «сочинил текст» (input.type / ui.invoke setValue / вставка) — ревью р1 #3/#9. */
export function isBatchComposeStep(s: { action?: unknown; params?: Record<string, unknown> }): boolean {
  const a = String(s.action ?? "");
  if (a === "input.type") return true;
  if (a === "ui.invoke" && (s.params ?? {}).pattern === "setValue") return true;
  if (a === "input.key" && isPasteCombo((s.params ?? {}).combo)) return true;
  return false;
}

/** Шаг берста «коммит отправки»: Enter/Ctrl+Enter ИЛИ клик/инвок (кнопка «Отправить», ревью р2 #3). */
export function isBatchSendStep(s: { action?: unknown; params?: Record<string, unknown> }): boolean {
  const a = String(s.action ?? "");
  if (a === "input.key") return isSendKey((s.params ?? {}).combo);
  return a === "input.click" || a === "input.mouse" || a === "ui.invoke";
}

/**
 * Разобрать берст input_batch на «сочинил текст → закоммитил» (ревью р1 #3/#9: send-commit-обход через
 * один вызов). Возвращает: committed — есть пара compose→send (в этом порядке) → долг сверки исхода;
 * endsComposed — последний содержательный шаг сочиняет текст (следующий отдельный Enter станет коммитом).
 */
export function inspectBatchSteps(input: unknown): { committed: boolean; endsComposed: boolean; hasSend: boolean } {
  const steps = (input as { steps?: Array<{ action?: unknown; params?: Record<string, unknown> }> })?.steps;
  if (!Array.isArray(steps)) return { committed: false, endsComposed: false, hasSend: false };
  let composedIdx = -1;
  let committed = false;
  let hasSend = false;
  for (let i = 0; i < steps.length; i += 1) {
    if (isBatchComposeStep(steps[i]!)) composedIdx = i;
    else if (isBatchSendStep(steps[i]!)) {
      hasSend = true; // ревью р3 #1/#4: коммит-шаг есть, даже если набор был в ПРОШЛОМ раунде (composedPending)
      if (composedIdx >= 0 && composedIdx < i) committed = true;
    }
  }
  const lastMeaningful = [...steps].reverse().find((s) => String(s.action ?? "") !== "wait");
  const endsComposed = lastMeaningful ? isBatchComposeStep(lastMeaningful) : false;
  return { committed, endsComposed, hasSend };
}

/**
 * Реплей небезопасен для слепого детерминированного исполнения (ревью Волны 3):
 *  (#5) есть app.launch/browser.open с подозрительной URI-схемой (обход SSRF/URL-гарда сервера);
 *  (#7) модель СОЧИНЯЕТ текст (input.type, обычно needsLlm) и следом КОММИТИТ его — отправка мимо
 *       send-гардов (confirm/cadence/проверка получателя). Коммит — это не только Enter: ревью фиксов
 *       (#8/#11) показало, что записанный показом навык чаще заканчивается КЛИКОМ по «Отправить»
 *       (input.click/input.mouse/ui.invoke) — любой такой шаг после сочинённого текста отменяет реплей.
 *       Ложный позитив (клик после type — не отправка) стоит дёшево: честный откат на обычную петлю.
 * Ревью фиксов, 2-й проход: (R1) ввод текста — это не только input.type: ui.invoke pattern="setValue"
 * пишет текст в контрол через UIA (первоклассный путь, demo-запись его генерит) — учитываем как
 * «сочинение»; (R2) input.type с текстом длиннее REPLAY_TYPE_MAX_CHARS не реплеим вовсе (typeText
 * даёт себе 5с+120мс/символ и НЕотменяем — ломал бы бюджет-инвариант «нет двух писателей»).
 * Экспорт — для регресс-тестов гарда (index.test.ts).
 */
export function replayUnsafe(steps: readonly SkillStep[]): boolean {
  for (const s of steps) {
    const p = s.params ?? {};
    if (s.action === "browser.open" && replayUriUnsafe(p.url)) return true;
    if (s.action === "app.launch" && replayUriUnsafe(p.app)) return true;
    if (s.action === "input.type" && typeof p.text === "string" && p.text.length > REPLAY_TYPE_MAX_CHARS) return true;
    if (s.action === "ui.invoke" && p.pattern === "setValue" && typeof p.value === "string" && p.value.length > REPLAY_TYPE_MAX_CHARS) return true;
  }
  // compose-and-commit: ввод текста (input.type / ui.invoke setValue) → далее Enter ИЛИ клик/инвок.
  const isComposeStep = (s: SkillStep): boolean =>
    s.action === "input.type" || (s.action === "ui.invoke" && (s.params ?? {}).pattern === "setValue");
  const typeIdx = steps.findIndex(isComposeStep);
  if (typeIdx >= 0) {
    for (let i = typeIdx + 1; i < steps.length; i += 1) {
      const s = steps[i]!;
      if (s.action === "input.key" && isSendKey((s.params ?? {}).combo)) return true;
      if (s.action === "input.click" || s.action === "input.mouse" || s.action === "ui.invoke") return true;
    }
  }
  return false;
}

/** Промис под жёстким таймаутом: reject по истечении ms (для НЕОБЯЗАТЕЛЬНЫХ шагов §10). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    if (typeof t === "object" && "unref" in t) (t as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Интервал опроса паузы и потолок ожидания (§20): не зависаем навсегда. */
export const PAUSE_POLL_MS = 150;
export const MAX_PAUSE_MS = 5 * 60_000;

/** Б4 (г): интервал опроса и окно ожидания восстановления канала. Окно < resume-grace (120с в registry) —
 *  reconnect обычно за секунды; не вернулся за это время → задача честно прерывается обрывом. */
export const CHANNEL_POLL_MS = 250;
export const CHANNEL_WAIT_MS = (() => {
  const n = Number.parseInt(process.env.JARVIS_CHANNEL_WAIT_MS ?? "", 10);
  return Number.isFinite(n) ? Math.min(110_000, Math.max(2_000, n)) : 30_000;
})();

/** Б3 (#2): минимум раундов между впрысками свежего снимка ПК — троттл против частых обновлений. */
export const LIVE_REFRESH_EVERY = 4;
/** Б3 (#3): максимум впрысков снимка за задачу — рост контекста ограничен (старые НЕ прунятся, кеш цел). */
export const MAX_LIVE_REFRESHES = 4;

/**
 * Кооперативная пауза (§20, user-takeover §6): пока задача в состоянии "paused" —
 * ждём (опрос), но не дольше MAX_PAUSE_MS и сразу выходим при отмене. Возобновление
 * (state→running) делает router (task.control resume / client.takeover active:false).
 */
export async function waitWhilePaused(task: Task, nowFn: () => number = () => Date.now()): Promise<void> {
  const start = nowFn();
  while (task.state === "paused" && !task.cancel.cancelled && nowFn() - start < MAX_PAUSE_MS) {
    await sleep(PAUSE_POLL_MS);
  }
}

/**
 * Б4 (г): дождаться восстановления канала с ПК (reconnect в resume-grace) — опрос session.channelUp()
 * до timeoutMs, ранний выход при отмене. Вернулся → true (петля повторит раунд той же моделью);
 * не вернулся за окно → false (задача честно прерывается обрывом связи, а не «провалом действия»).
 */
export async function waitForChannel(
  session: Pick<Session, "channelUp">,
  timeoutMs: number,
  task: Task,
  sleepFn: (ms: number) => Promise<void> = sleep,
  nowFn: () => number = () => Date.now(),
): Promise<boolean> {
  const start = nowFn();
  while (!session.channelUp() && !task.cancel.cancelled && nowFn() - start < timeoutMs) {
    await sleepFn(CHANNEL_POLL_MS);
  }
  return session.channelUp();
}

/** Стрим прогресса/состояния задачи на клиент (§20, task.status → renderer-панель). */
export function emitTaskStatus(session: Session, task: Task): void {
  const payload: TaskStatus = {
    taskId: task.taskId,
    state: task.state,
    title: task.title,
    summary: task.goal,
    stepsDone: task.stepsDone,
    stepsTotal: task.stepsTotal,
    // «Что делаю сейчас» — только для активной задачи; на терминале чип показывает итог, не последнее действие.
    ...(task.state === "running" && task.stepLabel ? { stepLabel: task.stepLabel } : {}),
  };
  session.send("task.status", payload);
}

/**
 * Грубая оценка стоимости вызова (для spend cap §14). Порядок величины в
 * нормализованных единицах: вход=1, кеш-чтение=0.1, кеш-запись=1.25, выход=5 —
 * отражает экономию prompt-кеша (§15).
 */
/**
 * Кеш-брейкпоинт растущего диалога (§15): держим РОВНО одну метку — на последнем
 * блоке последнего сообщения. Прежние снимаем, чтобы не упереться в лимит
 * брейкпоинтов Anthropic (≤4). Первый ход (content — строка) пропускаем.
 */
export function markCacheBreakpoint(convo: LlmMessage[]): void {
  for (const m of convo) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "text" || b.type === "tool_result") delete b.cache_control;
    }
  }
  const last = convo.at(-1);
  if (!last || typeof last.content === "string") return;
  const lastBlock = last.content.at(-1);
  if (lastBlock && (lastBlock.type === "text" || lastBlock.type === "tool_result")) {
    lastBlock.cache_control = { type: "ephemeral" };
  }
}

/**
 * Блок системного промпта из подобранного recall'ом навыка (§8 HERMES). Подаём его как
 * РУКОВОДСТВО к действию (следуй, если подходит), а не как факт — и явно разрешаем
 * игнорировать, если к текущей задаче навык не подходит (recall лексический, не идеален).
 */
export function formatRecalledSkill(s: RecalledSkill): string {
  return [
    `Навык «${s.name}» — применять, когда: ${s.when || "похожая задача"}.`,
    "",
    // §мультитенант: честная формулировка — общий приём из библиотеки vs собственный прошлый.
    s.fromShared ? "Процедура (проверенный приём из общей библиотеки):" : "Процедура (твой прошлый успешный приём):",
    s.procedure,
    "",
    // §8: навык — это команда-ДЕЙСТВИЕ. Раньше «следуй гибко… не подходит — игнорируй» давало лазейку
    // ответить болтовнёй вместо исполнения (наблюдённый баг с Дотой). Теперь обязываем ДЕЙСТВОВАТЬ
    // инструментами и проверять глазами; ветку «не подходит» сохраняем (recall лексический, не идеален).
    "Это команда-ДЕЙСТВИЕ: ИСПОЛНИ навык инструментами в ЭТОМ ходе (а не перескажи словами). " +
      "Следуй шагам гибко, но ОБЯЗАТЕЛЬНО вызови нужные инструменты и проверь исход глазами " +
      "(screen_capture/browser_read). Если навык к этой задаче явно не подходит — реши задачу " +
      "инструментами по-своему, но всё равно ДЕЙСТВУЙ, не отвечай одной болтовнёй.",
  ].join("\n");
}
