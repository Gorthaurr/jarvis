/**
 * РЕЗЕРВНЫЙ мозг на ПОДПИСКЕ (Claude Max) через Claude Agent SDK — волна G, 2026-08-31.
 *
 * Зачем: основной путь — Messages API по ключу (§7-каскад, prompt-кеш §15, свой agent-loop). Когда
 * ключ исчерпан («credit balance is too low»), кончились лимиты или моргнула сеть, Джарвис до сих пор
 * отвечал стабом «связь прервалась» и НИЧЕГО не делал. Подписка Max, за которую владелец уже платит,
 * остаётся неиспользованной. Этот провайдер даёт ей роль ЗАПАСНОГО канала.
 *
 * Официальность: Anthropic прямо описывает использование Agent SDK «in your own projects» под своей
 * подпиской (support.claude.com/articles/15036540; изменение, выносящее SDK-usage из лимитов, стоит
 * на паузе). Headless-авторизация — `claude setup-token` → env `CLAUDE_CODE_OAUTH_TOKEN`.
 * ⚠️ Личный проект на своём аккаунте — разрешённый сценарий; отдавать этот канал другим людям нельзя
 * (кредиты принадлежат аккаунту), и политика может измениться — тогда просто выключаем флаг.
 *
 * 🔴 ЧЕСТНО О РАЗНИЦЕ С ОСНОВНЫМ ПУТЁМ (резерв ≠ полноценная замена):
 *  • SDK владеет своим циклом и контекстом, поэтому НАШИ cache_control-брейкпоинты (§15) не
 *    применяются: каждый раунд отправляет историю заново. Дороже по токенам подписки — но это резерв.
 *  • История (assistant/tool_use/tool_result) сериализуется в ТЕКСТОВЫЙ транскрипт: SDK принимает
 *    только пользовательский промпт, а не наш формат блоков.
 *  • thinking-блоки не возвращаются (у нас их нет от SDK) — agent-loop это переживает: они нужны
 *    только при реплее в тот же API-ход, а резервный ход самодостаточен.
 *  • Инструменты отдаются модели как in-process MCP-инструменты, но ИСПОЛНЯЕТ их по-прежнему НАШ
 *    agent-loop: мы перехватываем первый tool_use из потока и возвращаем его наверх (аренда ввода,
 *    §14-гейты, verify-долг, метрики — всё остаётся на месте). SDK-хендлер до исполнения не доходит.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type Logger, createLogger } from "@jarvis/shared";
import type { ToolSchema } from "@jarvis/tools";
import { lazyDataPath } from "../paths.js";
import type { ILlmProvider, LlmDelta, LlmRequest, LlmResponse } from "./llm.js";
import { MCP_PREFIX, type SdkQuery, type SessionTurn, SubscriptionSession, type ToolOutcome, unwrapArgs } from "./subscription-session.js";

const log: Logger = createLogger("llm:subscription");

const SERVER_NAME = "jarvis";

/** Токен headless-доступа к подписке (claude setup-token). Пусто → пробуем сохранённый логин. */
function oauthToken(): string | undefined {
  const t = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  return t ? t : undefined;
}

/**
 * Сохранённый интерактивный логин Claude Code (`claude` → `/login`) — ВТОРОЙ путь авторизации резерва,
 * чтобы владельцу не приходилось вручную переносить секрет в `.env`.
 * ⚠️ Он МЕНЕЕ надёжен: сессия протухает и в фоновом сервисе не всегда рефрешится (живой зонд:
 * «OAuth session expired and could not be refreshed»). Поэтому наличие файла — лишь ОСНОВАНИЕ
 * попробовать: при отказе фолбэк честно деградирует в стаб и пишет причину в лог, а не молчит.
 */
function hasStoredLogin(): boolean {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return false;
  try {
    return existsSync(join(home, ".claude", ".credentials.json"));
  } catch {
    return false;
  }
}

/**
 * ПОЧЕМУ резерв не сработал — в терминах, понятных владельцу (2026-08-31, живой случай: OAuth-сессия
 * протухла, и канал молча отдавал стаб «связь прервалась»; из этого текста нельзя было понять, что
 * нужно всего лишь заново авторизоваться). Причина запоминается и попадает в паспорт возможностей,
 * чтобы Джарвис говорил «подписка не авторизована», а не изображал общий сбой связи.
 */
export type SubscriptionFailureKind = "auth" | "credits" | "rate_limit" | "other";

export interface SubscriptionFailure {
  kind: SubscriptionFailureKind;
  /** Что сказать владельцу. */
  human: string;
  at: number;
}

let lastFailure: SubscriptionFailure | undefined;

/** Классификация текста ошибки SDK (чистая функция). */
/**
 * «Ответ» модели — на самом деле ЭХО ошибки канала? (живой случай 2026-09-02, 10:11: SDK отдал
 * «You've hit your session limit · resets 2:20pm» и как assistant-текст, и как текст исключения;
 * ветка «частичный ответ» приняла это за работу модели, и владелец услышал сырую английскую ошибку
 * голосом дворецкого при ok:true в метриках).
 *
 * Судим ПО СОВПАДЕНИЮ с текстом ошибки, а не по словарю признаков: словарь ловил бы и законный
 * ответ на вопрос «что значит фраза You've hit your session limit» — то есть ложно проваливал бы
 * нормальный ход. Сравнение включающее: SDK оборачивает уведомление своим префиксом
 * («Claude Code returned an error result: …»), поэтому текст ответа оказывается ПОДСТРОКОЙ ошибки.
 * Чистая функция (экспорт — для тестов).
 */
export function isErrorEcho(answer: string, errorText: string): boolean {
  const norm = (s: string) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  const a = norm(answer);
  const e = norm(errorText);
  if (!a || !e) return false;
  if (a === e) return true;
  // КОРОТКИЙ ответ подстрокой не судим: «да» лежит внутри «неверные данные», и законный односложный
  // ответ модели был бы выброшен как эхо (ложный провал состоявшегося хода — та же нечестность
  // наизнанку). Настоящее уведомление канала длинное; порог отсекает случайные вхождения.
  if (a.length < MIN_ECHO_CHARS) return false;
  return e.includes(a) || a.includes(e);
}

/** Минимальная длина «ответа», при которой вхождение в текст ошибки — улика, а не совпадение. */
const MIN_ECHO_CHARS = 16;

export function classifySubscriptionError(text: string): SubscriptionFailure {
  const t = String(text ?? "");
  if (/authenticate|oauth|session expired|not logged in|unauthorized/i.test(t)) {
    return { kind: "auth", human: "подписка не авторизована (сессия истекла) — нужно выполнить `claude setup-token` и обновить CLAUDE_CODE_OAUTH_TOKEN", at: Date.now() };
  }
  // `session limit` — формулировка Claude Code при исчерпании окна подписки («You've hit your
  // session limit · resets 2:20pm»); раньше падала в «other» и доходила до владельца сырой строкой.
  if (/out of usage credits|usage limit|session limit|credit balance|quota/i.test(t)) {
    return { kind: "credits", human: "лимит подписки исчерпан — до сброса окна резерв недоступен", at: Date.now() };
  }
  if (/rate.?limit|429|too many requests/i.test(t)) {
    return { kind: "rate_limit", human: "подписка временно ограничивает частоту запросов", at: Date.now() };
  }
  return { kind: "other", human: `резервный канал не ответил: ${t.slice(0, 160)}`, at: Date.now() };
}

/**
 * Сколько причина отказа считается АКТУАЛЬНОЙ. Разовая 429 или моргнувшая сеть не должны неделю
 * висеть в паспорте как «канал не отвечает»: утверждение о СЕЙЧАС, основанное на давнем событии, —
 * такая же неправда, как «Готово» без проверки. Протухшая причина просто исчезает (мы не знаем).
 */
const FAILURE_TTL_MS = 30 * 60_000;

/** Последняя причина отказа резерва (для паспорта возможностей и честного доклада). */
export function lastSubscriptionFailure(): SubscriptionFailure | undefined {
  if (lastFailure && Date.now() - lastFailure.at > FAILURE_TTL_MS) lastFailure = undefined;
  return lastFailure;
}

/** Только для тестов: забыть причину. */
export function _resetSubscriptionFailureForTest(): void {
  lastFailure = undefined;
}

/** Только для тестов: подставить причину отказа (в бою её ставит сам провайдер по ответу SDK). */
export function _setSubscriptionFailureForTest(text: string): void {
  lastFailure = classifySubscriptionError(text);
}

/** Резерв включён? (env JARVIS_SUBSCRIPTION_FALLBACK=0 выключает даже при наличии токена.) */
export function subscriptionFallbackEnabled(): boolean {
  return process.env.JARVIS_SUBSCRIPTION_FALLBACK !== "0";
}

/**
 * Модель резерва. Проверено живым зондом на подписке владельца: доступны `fable` (→ claude-fable-5),
 * `opus` (→ claude-opus-5), а также полные id `claude-fable-5` / `claude-opus-5`.
 *
 * Решение владельца (2026-08-31): резерв работает на СИЛЬНОЙ модели — либо Fable 5, либо Opus 5.
 * Дефолт — **`opus`** (claude-opus-5): по замерам скорость у них одинаковая (латентность держит
 * оверхед SDK, а не модель), но Opus 5 экономнее расходует общий лимит подписки, который делится
 * с Claude Code владельца. Fable 5 остаётся доступен через `JARVIS_SUBSCRIPTION_MODEL=fable`.
 */
function subscriptionModel(): string {
  const raw = process.env.JARVIS_SUBSCRIPTION_MODEL?.trim();
  return raw || "opus";
}

/** Алиасы SDK → канонический id каталога (для ЧЕСТНОЙ отметки «кто на самом деле ответил»). */
const SUBSCRIPTION_MODEL_IDS: Record<string, string> = { opus: "claude-opus-5", fable: "claude-fable-5" };

/**
 * Какая модель РЕАЛЬНО отвечает по подписке — канонический id, а не алиас и не модель тира.
 * 🔴 До 2026-09-02 метрики и логи писали модель ТИРА основного канала (`claude-opus-4-8`), хотя ход
 * шёл по подписке на Opus 5: владелец спросил «там точно Opus 5?» — и ответить по логу было нельзя.
 * Модель тира на выбор модели резерва не влияет вообще (у SDK свой параметр), поэтому отметка обязана
 * приходить отсюда. Незнакомое значение env отдаём как есть — не выдумываем id.
 */
export function subscriptionModelId(): string {
  const raw = subscriptionModel();
  return SUBSCRIPTION_MODEL_IDS[raw.toLowerCase()] ?? raw;
}

/**
 * Рабочий каталог CLI-подпроцесса: ПУСТОЙ и не-git. Держим его в data/, а не во временной папке ОС:
 * так он переживает перезапуски (кеш CLI не сбрасывается каждым стартом) и попадает под те же
 * правила, что остальные наши сторы. Путь ленивый — `.env` (JARVIS_DATA_DIR) читается после импортов.
 */
const sdkSandboxDir = lazyDataPath("sdk-cwd");

/**
 * Окружение дочернего CLI. Кроме уже вычищенного ANTHROPIC_API_KEY просим часовой TTL кеша (на
 * подписке он даётся в рамках включённого объёма) и глушим автообновление — оно тратит время старта
 * и способно подменить версию CLI посреди рабочего дня. Значения не перетираем, если владелец задал свои.
 */
function applySandboxEnv(env: Record<string, string | undefined>): void {
  env.CLAUDE_CODE_PROMPT_CACHE_TTL ??= "1h";
  env.DISABLE_AUTOUPDATER ??= "1";
  // W2: результаты инструментов идут в модель MCP-результатом; дефолтный кап CLI (25K токенов) ниже
  // нашего серверного капа tool_result (80K символов ≈ 32K токенов кириллицы) — иначе CLI резал бы вывод.
  env.MAX_MCP_OUTPUT_TOKENS ??= "40000";
  try {
    mkdirSync(sdkSandboxDir(), { recursive: true });
  } catch (e) {
    // Каталог не создался (нет прав на JARVIS_DATA_DIR, занято файлом) — CLI отработает в дефолтном
    // cwd: канал важнее изоляции. Но МОЛЧАТЬ нельзя: изоляция тихо отключилась бы, а вместе с ней
    // вернулся бы расход лимита на подхваченные настройки проекта.
    log.warn("песочница резерва не создалась — изоляция подпроцесса не действует", {
      dir: sdkSandboxDir(),
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Эффорт резерва ПО ТИРУ (W2 «Мозг быстрый», 2026-09-09): haiku (простой вопрос) → medium,
 * sonnet (действие) → high, fable (сложное рассуждение / биржа / эскалация §7) → max.
 * Смена эффорта между сессиями кеш CLI НЕ ломает (зонд max→high→max: cache_read 29,9K на каждом) —
 * промахи в живом смоуке давал состав стабильного блока (навык/каталог), см. buildSystem.
 *
 * 🔴 ЭТО ПЕРЕСМОТР решения владельца от 2026-09-02 («opus 5 на максимальном эффорте на каждом ходе»),
 * сделанный по его же новому запросу от 2026-09-09 «подумай, как ускорить по подписке». Что известно
 * по замерам: на коротком ответе эффорт латентность почти не меняет (TTFT 2,7-3,1 с и на max, и на
 * medium), а p90 хода (20-31 с) держит ДЛИННОЕ РАЗМЫШЛЕНИЕ на реальных задачах — его и режет эффорт.
 * Цена: вопрос на medium может опереться на память там, где max сходил бы за инструментом (эпизод
 * 2026-09-02 15:49 «какой билд на Эмбере» был на `low` — ниже medium не опускаемся); эскалация §7
 * и биржа по-прежнему уходят на max. Дорога назад — `JARVIS_SUBSCRIPTION_EFFORT=max` (перекрывает
 * все тиры), задокументирована в .env.example. Модель остаётся Opus 5 (решение владельца цело).
 */
const TIER_EFFORT: Record<string, string> = { haiku: "medium", sonnet: "high", fable: "max" };

function subscriptionEffort(tier?: string): string {
  const raw = process.env.JARVIS_SUBSCRIPTION_EFFORT?.trim().toLowerCase();
  if (raw && EFFORTS.includes(raw)) return raw;
  return TIER_EFFORT[tier ?? ""] ?? "max";
}

/**
 * thinking-опция SDK — ВСЕГДА `adaptive` (W2, 2026-09-09).
 *
 * 🔴 Зонд на подписке: смена типа thinking (disabled ↔ adaptive) при том же системном промпте =
 * ПРОМАХ КЕША CLI целиком (cache_read 0, cache_creation 29,9K), тогда как смена эффорта кеш не трогает.
 * Пер-раундовая политика §2.7 («off» на механике) на подписке поэтому НЕ применяется: один
 * механический раунд без размышления обходился бы переписью 81K-персоны в кеш и терял бы кеш для
 * следующего раунда — дороже и медленнее любого «лишнего» размышления. Глубину задаёт эффорт по тиру
 * (medium/high/max), adaptive на medium/high — короткое размышление. Внутри сессии SDK опция всё равно
 * фиксируется на старте, так что «менять по раундам» там и негде.
 */
function thinkingOption(_effort: LlmRequest["thinking"], _tier?: string): Record<string, unknown> {
  return { type: "adaptive" };
}

/**
 * Системный промпт для SDK. Раньше склеивался в ОДНУ строку — и вместе с ней терялась граница §15
 * между стабильной частью и меняющейся каждый ход динамикой (время, окна ПК, факты). Установленный
 * SDK 0.3.251 умеет эту границу принимать буквально: массив строк с маркером
 * `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, где всё ДО маркера пригодно для кросс-сессионного кеша, а всё ПОСЛЕ — нет.
 *
 * 🔴 W2 (живой смоук 2026-09-09 07:04-07:21): у CLI ОДИН кеш-блок до границы — любая правка в нём =
 * промах на весь блок (cache_read 0, cache_creation ~81K на каждой новой задаче). До границы раньше
 * входили и блок навыка (recall — свой на каждую задачу), и каталог холодных инструментов
 * (меняется `tool_load`) — и персона в 81K токенов переписывалась в кеш почти на каждой задаче.
 * Эффорт кеш НЕ ломает (зонд: max→high→max, cache_read 29,9K на каждом). Поэтому до границы —
 * ТОЛЬКО персона (`systemStatic`); навык и каталог — после, вместе с динамикой (они на порядок меньше).
 * На API-канале у навыка свой брейкпоинт (`anthropic.buildSystemBlocks`) — там ничего не меняется.
 *
 * Маркер берём из SDK (не хардкодим строку): его значение — деталь реализации SDK, а не контракт.
 * Нет маркера в этой версии → честно отдаём одну строку, как раньше (кеша не будет, но и поломки тоже).
 */
function buildSystem(req: LlmRequest, boundary?: string): string | string[] {
  const stable = (req.systemStatic ?? "").trim();
  const dynamic = [req.systemSkill, req.systemTools, req.systemDynamic].filter((s) => s && s.trim()).join("\n\n");
  if (!boundary || !stable || !dynamic) {
    return [stable, dynamic].filter(Boolean).join("\n\n");
  }
  return [stable, boundary, dynamic];
}

/**
 * Сколько ПОСЛЕДНИХ картинок доносим до модели. Больше одной-двух не нужно: петля и так прунит
 * устаревшие скриншоты (`JARVIS_KEEP_SCREENSHOTS`), а каждая — ~2000 токенов лимита подписки.
 */
const MAX_IMAGES = 2;

/** Текст из блока результата инструмента (картинки идут отдельными блоками — см. collectImages). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((b) => {
      const blk = b as { type?: string; text?: string };
      if (blk.type === "text") return blk.text ?? "";
      if (blk.type === "image") return "[скриншот — приложен отдельным блоком ниже]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * 🔴 ЗРЕНИЕ В РЕЗЕРВЕ: собрать ПОСЛЕДНИЕ картинки истории, чтобы приложить их к промпту.
 * Без этого резерв делал Джарвиса СЛЕПЫМ (screen_capture возвращал только метку), а зрение — его
 * суть на GUI-задачах: «клик ≠ результат, сверь глазами» без картинки невыполнимо, и петля получала
 * бы ложное основание считать действие непроверяемым. SDK принимает Messages-API-блоки в
 * streaming-input режиме, поэтому картинки доносим как есть.
 */
function collectImages(req: LlmRequest): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (const m of req.messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "image") found.push({ type: "image", source: b.source });
      else if (b.type === "tool_result" && Array.isArray(b.content)) {
        for (const inner of b.content) if (inner.type === "image") found.push({ type: "image", source: inner.source });
      }
    }
  }
  return found.slice(-MAX_IMAGES); // свежие важнее: экран мог измениться
}

/**
 * История в ТЕКСТОВЫЙ транскрипт (SDK принимает только промпт пользователя). Формат явно размечен,
 * чтобы модель не путала свои прошлые ходы с речью владельца — тот же принцип, что в журнале
 * чекпойнта волны C: врезки петли не должны читаться как реплики владельца.
 */
export function serializeHistory(req: LlmRequest): string {
  const parts: string[] = [];
  for (const m of req.messages) {
    const who = m.role === "user" ? "ВЛАДЕЛЕЦ/СИСТЕМА" : "ТЫ (прошлый ход)";
    if (typeof m.content === "string") {
      if (m.content.trim()) parts.push(`### ${who}\n${m.content}`);
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text") {
        if (b.text.trim()) parts.push(`### ${who}\n${b.text}`);
      } else if (b.type === "tool_use") {
        parts.push(`### ТЫ ВЫЗВАЛ ИНСТРУМЕНТ\n${b.name}(${JSON.stringify(b.input)})`);
      } else if (b.type === "tool_result") {
        const err = b.is_error ? " [ОШИБКА]" : "";
        parts.push(`### РЕЗУЛЬТАТ ИНСТРУМЕНТА${err}\n${toolResultText(b.content).slice(0, 4000)}`);
      } else if (b.type === "image") {
        parts.push("### СКРИНШОТ\n[приложен отдельным блоком ниже]");
      }
      // thinking/redacted_thinking в транскрипт не идут: они бессмысленны вне своего API-хода.
    }
  }
  return parts.join("\n\n");
}

export interface SubscriptionLlmDeps {
  /** Инъекция SDK для тестов (по умолчанию — динамический импорт настоящего). */
  loadSdk?: () => Promise<SdkModule>;
  now?: () => number;
}

/** Минимальный контракт используемой части SDK (позволяет тестировать без сети). */
export interface SdkModule {
  /** Прогрев CLI-подпроцесса (опционально — в старых версиях SDK может отсутствовать). */
  startup?: (opts?: unknown) => Promise<unknown>;
  /** Маркер границы кеша системного промпта (появился не во всех версиях — используем, если есть). */
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY?: string;
  query: SdkQuery;
  tool: (name: string, description: string, schema: unknown, handler: (args: unknown) => Promise<unknown>) => unknown;
  createSdkMcpServer: (opts: { name: string; tools: unknown[]; timeout?: number }) => unknown;
}

/**
 * Потолки сессии (W2). Ход модели — до 10 мин (max-эффорт на сложной задаче думает минутами; петля
 * держит свой потолок задачи и отменит раньше). Ожидание результата инструмента — те же 10 мин:
 * `skill.execute` до 130 с, `code_run` до 180 с, `wait_for` — минуты. Больше всех живых сессий, чем
 * слотов параллельности, быть не должно — каждая = CLI-процесс.
 */
const TURN_TIMEOUT_MS = 10 * 60_000;
const TOOL_WAIT_MS = 10 * 60_000;
const SESSION_MAX_TURNS = 500;
const MAX_SESSIONS = 6;

/** Продолжение сессии: результаты инструментов из хвоста запроса, если он ровно их и содержит. */
export function continuationOutcomes(req: LlmRequest, pendingIds: Set<string>): ToolOutcome[] | undefined {
  const last = req.messages[req.messages.length - 1];
  if (!last || last.role !== "user" || typeof last.content === "string") return undefined;
  const results = last.content.filter((b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result");
  const texts = last.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text").map((b) => b.text).filter((t) => t.trim());
  const other = last.content.some((b) => b.type !== "tool_result" && b.type !== "text");
  if (other || results.length === 0 || results.length !== pendingIds.size) return undefined;
  if (!results.every((r) => pendingIds.has(r.tool_use_id))) return undefined;
  const outcomes: ToolOutcome[] = results.map((r) => ({ toolUseId: r.tool_use_id, content: r.content, isError: r.is_error }));
  if (texts.length > 0) {
    // Врезки петли (нудж, поправка на ходу, live-контекст) идут в этом же user-сообщении текстом.
    // В сессии SDK отдельного канала для них нет — доносим хвостом последнего результата, размеченно:
    // модель обязана отличать наш статус от вывода инструмента (та же логика, что в транскрипте).
    const lastOut = outcomes[outcomes.length - 1] as ToolOutcome;
    const note = `\n\n### ВЛАДЕЛЕЦ/СИСТЕМА (примечание к этому ходу)\n${texts.join("\n\n")}`;
    lastOut.content = typeof lastOut.content === "string" ? lastOut.content + note : [...lastOut.content, { type: "text", text: note }];
  }
  return outcomes;
}

/** Условия, при которых сессию можно продолжать: та же модель/эффорт/набор инструментов/стабильный system. */
function sessionFingerprint(req: LlmRequest): string {
  // Навык и каталог в отпечатке: внутри сессии они зафиксированы на старте (в кеш-блок CLI не входят).
  const stable = [req.systemStatic, req.systemSkill, req.systemTools].filter((s) => s && s.trim()).join("\n\n");
  return [subscriptionModel(), subscriptionEffort(req.tier), (req.tools ?? []).map((t) => t.name).join(","), stable].join(" ");
}

export class SubscriptionLlmProvider implements ILlmProvider {
  private sdk: SdkModule | null = null;
  private readonly loadSdk: () => Promise<SdkModule>;
  private readonly now: () => number;
  /** Живые сессии по ключу задачи (W2). */
  private readonly sessions = new Map<string, SubscriptionSession>();

  constructor(deps: SubscriptionLlmDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.loadSdk =
      deps.loadSdk ??
      (async () => {
        const mod = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as SdkModule;
        return mod;
      });
  }

  /**
   * Резерв доступен? Два основания: явный headless-токен (надёжный путь) ИЛИ сохранённый логин
   * Claude Code (удобный путь — без переноса секрета руками, но сессия может протухнуть).
   * Обещание тут МЯГКОЕ по конструкции: при отказе авторизации фолбэк отдаёт честный стаб и пишет
   * причину, поэтому «попробовать логин» не создаёт ложных обещаний владельцу.
   */
  get live(): boolean {
    return subscriptionFallbackEnabled() && (oauthToken() !== undefined || hasStoredLogin());
  }

  /** Каким основанием авторизуемся — для boot-лога (владелец должен понимать, что именно работает). */
  static authMode(): "token" | "stored-login" | "none" {
    if (oauthToken()) return "token";
    return hasStoredLogin() ? "stored-login" : "none";
  }

  /** Понятная причина недоступности — для честного ответа владельцу и boot-лога. */
  static unavailableReason(): string | undefined {
    if (!subscriptionFallbackEnabled()) return "резерв по подписке выключен (JARVIS_SUBSCRIPTION_FALLBACK=0)";
    if (SubscriptionLlmProvider.authMode() === "none") {
      return "нет авторизации подписки: `claude setup-token` → CLAUDE_CODE_OAUTH_TOKEN в .env (надёжно) ИЛИ `claude` → /login (проще)";
    }
    return undefined;
  }

  /** Сколько сессий живо сейчас (диагностика/тесты). */
  get liveSessions(): number {
    return this.sessions.size;
  }

  /** Задача завершена — её сессия SDK больше не нужна (петля зовёт из finally). */
  release(key: string): void {
    this.drop(key, "задача завершена");
  }

  private drop(key: string, reason: string): void {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    s.close(reason);
  }

  /**
   * Прогрев резервного канала на boot (fire-and-forget). SDK поднимает CLI-подпроцесс, и часть этой
   * работы (~0.6с по замеру) можно оплатить заранее, а не на первой реплике владельца. Полностью
   * оверхед не снимает (замер: ~3.2-3.8с до первого токена и с прогревом, и без) — но первый ход
   * после старта перестаёт быть заметно медленнее остальных. Ошибки глушим: прогрев не обязан
   * удаваться (нет сети/токен протух — узнаем на реальном ходе честной деградацией).
   */
  async warmup(): Promise<void> {
    if (!this.live) return;
    try {
      const sdk = this.sdk ?? (this.sdk = await this.loadSdk());
      const start = (sdk as unknown as { startup?: (o?: unknown) => Promise<unknown> }).startup;
      if (typeof start === "function") {
        const env: Record<string, string | undefined> = { ...process.env };
        delete env.ANTHROPIC_API_KEY;
        applySandboxEnv(env);
        // Прогревать нужно ТЕМИ ЖЕ опциями, с какими пойдёт рабочий вызов: иначе прогреется не тот
        // подпроцесс (другой cwd/набор настроек), и первый настоящий ход всё равно заплатит стартом.
        const warm = (await start({ options: { env, settingSources: [], strictMcpConfig: true, cwd: sdkSandboxDir() } })) as
          | { close?: () => void }
          | undefined;
        // 🔴 Хендл прогрева ОДНОРАЗОВЫЙ и жёстко связан с опциями, которыми его создали, а у нас
        // опции меняются каждый ход (свой системный промпт, свой набор инструментов, размышление по
        // политике) — использовать его в рабочем вызове нельзя. Значит держать процесс незачем:
        // не закрыв, мы бы оставляли висеть лишний CLI на каждый старт сервера (ревью волны I).
        // Польза прогрева — в прогретом дисковом кеше и распакованных модулях, она сохраняется.
        try {
          warm?.close?.();
        } catch {
          /* закрывать нечего — не беда */
        }
        log.info("резервный канал прогрет");
      }
    } catch (e) {
      log.debug("прогрев резерва не удался (не критично)", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    return this.run(req, undefined);
  }

  async completeStream(req: LlmRequest, onDelta: (d: LlmDelta) => void): Promise<LlmResponse> {
    return this.run(req, onDelta);
  }

  private async run(req: LlmRequest, onDelta?: (d: LlmDelta) => void): Promise<LlmResponse> {
    const sdk = this.sdk ?? (this.sdk = await this.loadSdk());
    const key = req.sessionKey;
    const fingerprint = sessionFingerprint(req);
    const t0 = this.now();

    // W2: ПРОДОЛЖЕНИЕ живой сессии — хвост запроса ровно результаты ожидаемых инструментов.
    if (key) {
      const live = this.sessions.get(key);
      if (live) {
        const outcomes = live.alive && live.fingerprint === fingerprint ? continuationOutcomes(req, live.pendingIds()) : undefined;
        if (outcomes) {
          let turn: SessionTurn;
          try {
            turn = await live.continueWith(outcomes, onDelta);
          } catch (e) {
            this.drop(key, "продолжение не удалось");
            throw e;
          }
          if (turn.ended) this.drop(key, "ход завершён");
          return this.toResponse(req, turn, onDelta, "continued", t0);
        }
        this.drop(key, !live.alive ? "прежняя сессия завершилась" : live.fingerprint !== fingerprint ? "изменились модель/эффорт/инструменты" : "история разошлась с сессией");
      }
    }

    // ANTHROPIC_API_KEY ПОБЕЖДАЕТ подписку в порядке кредов SDK — в резерве он именно тот канал,
    // который уже не работает, поэтому вычищаем его из окружения дочернего процесса.
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const token = oauthToken();
    // Токена нет → НЕ подсовываем пустое значение: SDK должен взять сохранённый логин Claude Code.
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    else delete env.CLAUDE_CODE_OAUTH_TOKEN;

    // ИЗОЛЯЦИЯ ПОДПРОЦЕССА (2026-08-31, по документации установленного SDK, sdk.d.ts:2052 —
    // «When omitted, all sources are loaded… Must include 'project' to load CLAUDE.md files»).
    // 🔴 Мы не передавали ни `cwd`, ни `settingSources` — значит дочерний CLI стартовал в
    // `apps/server`, поднимался по дереву и подхватывал настройки проекта вместе с CLAUDE.md
    // (у нас это 350 КБ карты репозитория) в КАЖДЫЙ ход. Модели в рантайме этот документ не нужен —
    // у Джарвиса свой системный промпт, — а лимит подписки он расходует общий с Claude Code владельца.
    // Поэтому: пустой список источников + отдельный ПУСТОЙ рабочий каталог (не-git, чтобы не
    // подцепить и статус репозитория). Путь ленивый — `.env` читается ПОСЛЕ ESM-импортов (грабля волны E).
    applySandboxEnv(env);
    // Потолок вывода хода: у SDK нет per-call параметра — он читается из env дочернего процесса.
    if (req.maxTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(req.maxTokens);

    const session = new SubscriptionSession(sdk.query, {
      fingerprint,
      turnTimeoutMs: TURN_TIMEOUT_MS,
      idleTimeoutMs: TOOL_WAIT_MS,
      now: this.now,
      onClose: (reason) => {
        if (key && this.sessions.get(key) === session) {
          this.sessions.delete(key);
          log.debug("резерв: сессия закрыта", { key, reason });
        }
      },
    });
    const tools = buildTools(sdk, req.tools ?? [], session);
    const options: Record<string, unknown> = {
      systemPrompt: buildSystem(req, sdk.SYSTEM_PROMPT_DYNAMIC_BOUNDARY),
      model: subscriptionModel(),
      effort: subscriptionEffort(req.tier),
      settingSources: [],
      strictMcpConfig: true,
      cwd: sdkSandboxDir(),
      // W2: с ключом сессии цикл живёт всю задачу (наш хендлер отдаёт результаты петли); без ключа —
      // разовый вызов: SDK возвращает первый ход и останавливается, как в волне G.
      maxTurns: key ? SESSION_MAX_TURNS : 1,
      // Никаких встроенных инструментов Claude Code (Bash/Read/...): у Джарвиса свой арсенал и свои гейты.
      tools: [],
      ...(tools.length > 0
        ? {
            mcpServers: { [SERVER_NAME]: sdk.createSdkMcpServer({ name: SERVER_NAME, tools, timeout: TOOL_WAIT_MS }) },
            allowedTools: [`${MCP_PREFIX}*`],
          }
        : {}),
      // §7/§2.7: размышление — по нашей пер-раундовой политике, а не по дефолту SDK.
      thinking: thinkingOption(req.thinking, req.tier),
      env,
      // Дельты нужны и продолжениям сессии (у которых свой onDelta) — включаем всегда, дёшево.
      includePartialMessages: true,
    };

    // Зрение: есть картинки → streaming-input (блоки Messages API), иначе — обычный текстовый промпт.
    const transcript = serializeHistory(req);
    const images = collectImages(req);
    const prompt = images.length > 0 ? userMessageStream(transcript, images) : transcript;

    if (key) {
      if (this.sessions.size >= MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.drop(oldest, "слишком много живых сессий");
      }
      this.sessions.set(key, session);
    }
    let turn: SessionTurn;
    try {
      turn = await session.start(prompt, options, onDelta);
    } catch (e) {
      this.drop(key ?? "", "старт не удался");
      session.close("старт не удался");
      throw e;
    }
    // Разовый вызов (без ключа) исполняет инструмент НАШ agent-loop — SDK дальше не пускаем:
    // досмотрев поток, он дождался бы хендлера с новым вызовом, и действие исполнилось бы дважды.
    if (!key || turn.ended) {
      session.close(key ? "ход завершён" : "разовый вызов");
      if (key) this.sessions.delete(key);
    }
    return this.toResponse(req, turn, onDelta, "fresh", t0, transcript, options);
  }

  /** Ход сессии → ответ провайдера: честность по ошибкам, usage, метрика раунда. */
  private toResponse(
    req: LlmRequest,
    turn: SessionTurn,
    onDelta: ((d: LlmDelta) => void) | undefined,
    mode: "fresh" | "continued",
    t0: number,
    transcript?: string,
    options?: Record<string, unknown>,
  ): LlmResponse {
    let text = turn.text;
    if (!text && turn.resultText && turn.toolUses.length === 0) text = turn.resultText;
    const errorText = turn.errorText;
    // Ошибку поднимаем, только если ход ничего не дал: пришедший текст/вызов инструмента — уже
    // результат, и превращать его в стаб (потеря работы модели) было бы ложным провалом.
    // 🔴 Исключение — ЭХО ошибки (живой баг 2026-09-02, 10:11): у SDK текст ошибки приходит и как
    // «ответ ассистента» — владельцу озвучили сырое «You've hit your session limit» голосом
    // дворецкого, а ход записали успешным. «Ответ», совпадающий с текстом ошибки, результатом не является.
    if (errorText && turn.toolUses.length === 0 && (!text || isErrorEcho(text, errorText))) {
      lastFailure = classifySubscriptionError(errorText);
      log.warn("резерв недоступен", { kind: lastFailure.kind, human: lastFailure.human, эхоОшибки: Boolean(text), mode });
      throw new Error(`подписка: ${lastFailure.human}`);
    }
    if (errorText) log.warn("резерв: поток оборвался после частичного ответа — отдаю, что получил", { error: errorText });
    // Ход прошёл — прежняя причина отказа больше не актуальна (иначе паспорт врал бы о мёртвом канале).
    lastFailure = undefined;

    // usage — per-call числа ассистентского сообщения SDK: input + cache_read + cache_creation = РЕАЛЬНЫЙ
    // размер промпта этого вызова (в сессии история сидит в кеше — так гард контекст-окна видит правду).
    // SDK не отдал usage (сбой/мок) → оцениваем вход сами по тому, что отправили (2.5 симв/ток, кириллица).
    let usage = turn.usage;
    if (usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens === 0 && transcript !== undefined) {
      const sp = options?.systemPrompt;
      const promptChars = (Array.isArray(sp) ? sp.join("\n\n") : String(sp ?? "")).length + transcript.length;
      usage = { ...usage, inputTokens: Math.ceil(promptChars / 2.5) };
    }
    const totalMs = this.now() - t0;
    log.info("резерв: раунд", {
      mode,
      tier: req.tier,
      effort: subscriptionEffort(req.tier),
      initMs: turn.initMs,
      ttftMs: turn.ttftMs,
      totalMs,
      in: usage.inputTokens,
      cacheRead: usage.cacheReadTokens,
      cacheCreate: usage.cacheCreationTokens,
      out: usage.outputTokens,
      toolUses: turn.toolUses.map((u) => u.name),
    });
    const finalText = onDelta ? text : text;
    return {
      text: finalText.trim(),
      toolUses: turn.toolUses,
      stopReason: turn.toolUses.length > 0 ? "tool_use" : "end_turn",
      usage,
      stubbed: false,
      channel: "subscription", // расход считается лимитами подписки, а не долларами API
      // Кто РЕАЛЬНО ответил: модель тира основного канала тут ни при чём (у SDK свой параметр), а
      // метрики/логи писали именно её — по ним нельзя было ответить «там точно Opus 5?».
      modelUsed: subscriptionModelId(),
    };
  }
}

/**
 * Один user-ход с блоками (текст + картинки) в формате streaming-input SDK. Генератор завершается
 * сразу: продолжения диалога идут через результаты инструментов (сессия W2), а не новыми user-ходами.
 */
function userMessageStream(text: string, images: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  return (async function* () {
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text }, ...images] },
    };
  })();
}

/**
 * Наши JSON-Schema-инструменты → инструменты SDK. `tool()` требует zod-shape, а у нас сырая JSON
 * Schema, поэтому объявляем ОДИН свободный параметр `args` и кладём настоящую схему в описание:
 * строгую валидацию всё равно делает наш dispatch, а модель видит поля из описания.
 * Хендлер (W2) не исполняет сам: он ЖДЁТ результат от agent-loop через сессию и отдаёт его SDK.
 */
function buildTools(sdk: SdkModule, schemas: readonly ToolSchema[], session: SubscriptionSession): unknown[] {
  // Лимит Anthropic на имя инструмента — 64 символа, а в резерве к имени добавляется наш префикс
  // `mcp__jarvis__` (13). Наши имена короткие, но инструменты ВНЕШНИХ MCP-серверов приходят уже с
  // собственным префиксом (`mcp__github__…` — проверено живым зондом: срез префикса восстанавливает
  // исходное имя корректно). Экзотически длинное имя молча ломало бы вызов — лучше честно не
  // предлагать его в резерве и сказать об этом в логе.
  const fits = schemas.filter((s) => {
    if (MCP_PREFIX.length + s.name.length <= 64) return true;
    log.warn("резерв: имя инструмента не влезает в лимит 64 с префиксом — в резерве недоступен", { tool: s.name });
    return false;
  });
  return fits.map((s) =>
    sdk.tool(
      s.name,
      `${s.description}\n\nПАРАМЕТРЫ (JSON Schema) — передавай их объектом в поле args:\n${JSON.stringify(s.input_schema)}`,
      argsShape(),
      async (args: unknown) => session.handle(s.name, unwrapArgs(args)),
    ),
  );
}

/**
 * zod-shape свободного объекта аргументов (единственное место, где нужен zod).
 * ⚠️ Импорт СТАТИЧЕСКИЙ: `require` в ESM-сборке сервера не существует — живой прогон резерва падал
 * с «require is not defined» ровно здесь, уже после успешного переключения канала.
 */
function argsShape(): Record<string, unknown> {
  return { args: z.record(z.string(), z.unknown()) };
}
