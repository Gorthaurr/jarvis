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
import { newId } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import type { ToolSchema } from "@jarvis/tools";
import { lazyDataPath } from "../paths.js";
import type { ILlmProvider, LlmDelta, LlmRequest, LlmResponse, ToolUse } from "./llm.js";

const log: Logger = createLogger("llm:subscription");

/** Префикс, который SDK даёт инструментам нашего in-process MCP-сервера. */
const MCP_PREFIX = "mcp__jarvis__";
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
export function classifySubscriptionError(text: string): SubscriptionFailure {
  const t = String(text ?? "");
  if (/authenticate|oauth|session expired|not logged in|unauthorized/i.test(t)) {
    return { kind: "auth", human: "подписка не авторизована (сессия истекла) — нужно выполнить `claude setup-token` и обновить CLAUDE_CODE_OAUTH_TOKEN", at: Date.now() };
  }
  if (/out of usage credits|usage limit|credit balance|quota/i.test(t)) {
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
 * Эффорт резерва — ПО ТИРУ ХОДА (скорость vs качество, замерено живьём 2026-08-31).
 *
 * Замер показал: латентность резерва почти НЕ зависит от эффорта и модели (5.2-5.9с полного ответа,
 * первый токен 3.2-4.7с) — она упирается в оверхед SDK (CLI-подпроцесс), а не в генерацию. Значит
 * держать `max` на КАЖДОМ ходе смысла нет: разговорные реплики от этого не ускорятся, но и качество
 * им не нужно. Поэтому: обычные ходы (haiku/sonnet) — `low` (голосу важен первый токен), а тир
 * `fable` (эскалация §7, трейдинг, сложное рассуждение) — `max`: туда ход попадает, когда качество
 * реально решает. Переопределяется `JARVIS_SUBSCRIPTION_EFFORT` (один на всё) — если владелец
 * захочет фиксированный уровень.
 */
function subscriptionEffort(tier?: string): string {
  const raw = process.env.JARVIS_SUBSCRIPTION_EFFORT?.trim().toLowerCase();
  if (raw && EFFORTS.includes(raw)) return raw;
  return tier === "fable" ? "max" : "low";
}

/**
 * Наш эффорт (§7: "off" | "adaptive" | число-бюджет) → thinking-опция SDK.
 * Резерв ОБЯЗАН уважать пер-раундовую политику размышления (`agent/thinking-policy.ts`): иначе
 * механические раунды думали бы зря (лишние секунды и токены лимита подписки), а verify-раунд —
 * наоборот, шёл бы без размышления, где оно честностно важно («получилось или нет» решает
 * интерпретация наблюдения). До этого в SDK не передавалось НИЧЕГО и действовал его дефолт.
 */
function thinkingOption(effort: LlmRequest["thinking"], tier?: string): Record<string, unknown> {
  // На высоком эффорте размышление НЕ глушим, даже если пер-раундовая политика просила «off»:
  // «max без размышления» — противоречие (эффорт и есть бюджет обдумывания). На низких эффортах
  // политика §2.7 уважается как есть — это и есть быстрый путь для разговорных ходов.
  const eff = subscriptionEffort(tier);
  const strong = eff === "max" || eff === "xhigh";
  if (!effort || effort === "off") return strong ? { type: "adaptive" } : { type: "disabled" };
  if (effort === "adaptive") return { type: "adaptive" };
  // Числовой бюджет: у подписки семейства моделей свежие (Opus/Fable 5), где enabled+budget даёт
  // 400 — как и в основном канале, честно уходим в adaptive, а не гадаем бюджетом вслепую.
  return { type: "adaptive" };
}

/** Собрать системный промпт из наших блоков (кеш-брейкпоинты в резерве не применимы — см. шапку). */
/**
 * Системный промпт для SDK. Раньше склеивался в ОДНУ строку — и вместе с ней терялась граница §15
 * между стабильной частью (персона/навык/каталог инструментов) и меняющейся каждый ход динамикой
 * (время, окна ПК, факты). Установленный SDK 0.3.251 умеет эту границу принимать буквально: массив
 * строк с маркером `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, где всё ДО маркера пригодно для кросс-сессионного
 * кеша, а всё ПОСЛЕ — нет. Это ровно наша схема [персона][навык] / [динамика] из `persona/index.ts`.
 *
 * Маркер берём из SDK (не хардкодим строку): его значение — деталь реализации SDK, а не контракт.
 * Нет маркера в этой версии → честно отдаём одну строку, как раньше (кеша не будет, но и поломки тоже).
 */
function buildSystem(req: LlmRequest, boundary?: string): string | string[] {
  const stable = [req.systemStatic, req.systemSkill, req.systemTools].filter((s) => s && s.trim()).join("\n\n");
  const dynamic = (req.systemDynamic ?? "").trim();
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

/** Найти tool_use среди блоков ответа SDK и привести к нашему формату (срезав MCP-префикс). */
function extractToolUses(content: unknown): ToolUse[] {
  if (!Array.isArray(content)) return [];
  const out: ToolUse[] = [];
  for (const b of content) {
    const blk = b as { type?: string; id?: string; name?: string; input?: unknown };
    if (blk.type !== "tool_use" || !blk.name) continue;
    const bare = blk.name.startsWith(MCP_PREFIX) ? blk.name.slice(MCP_PREFIX.length) : blk.name;
    // Аргументы приходят завёрнутыми в `args` (см. buildTools: свободный объект вместо zod-схемы).
    const raw = (blk.input ?? {}) as Record<string, unknown>;
    const input = (raw.args && typeof raw.args === "object" ? raw.args : raw) as Record<string, unknown>;
    out.push({ id: blk.id || newId(), name: bare, input });
  }
  return out;
}

/** Текст из блоков ответа SDK. */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      const blk = b as { type?: string; text?: string };
      return blk.type === "text" ? (blk.text ?? "") : "";
    })
    .join("");
}

export interface SubscriptionLlmDeps {
  /** Инъекция SDK для тестов (по умолчанию — динамический импорт настоящего). */
  loadSdk?: () => Promise<SdkModule>;
}

/** Минимальный контракт используемой части SDK (позволяет тестировать без сети). */
export interface SdkModule {
  /** Прогрев CLI-подпроцесса (опционально — в старых версиях SDK может отсутствовать). */
  startup?: (opts?: unknown) => Promise<unknown>;
  /** Маркер границы кеша системного промпта (появился не во всех версиях — используем, если есть). */
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY?: string;
  query: (opts: {
    prompt: string | AsyncIterable<Record<string, unknown>>;
    options: Record<string, unknown>;
  }) => AsyncIterable<Record<string, unknown>>;
  tool: (name: string, description: string, schema: unknown, handler: (args: unknown) => Promise<unknown>) => unknown;
  createSdkMcpServer: (opts: { name: string; tools: unknown[] }) => unknown;
}

export class SubscriptionLlmProvider implements ILlmProvider {
  private sdk: SdkModule | null = null;
  private readonly loadSdk: () => Promise<SdkModule>;

  constructor(deps: SubscriptionLlmDeps = {}) {
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
    const captured: ToolUse[] = [];
    const tools = buildTools(sdk, req.tools ?? [], captured);
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
    const options: Record<string, unknown> = {
      systemPrompt: buildSystem(req, sdk.SYSTEM_PROMPT_DYNAMIC_BOUNDARY),
      model: subscriptionModel(),
      effort: subscriptionEffort(req.tier),
      settingSources: [],
      strictMcpConfig: true,
      cwd: sdkSandboxDir(),
      // Свой цикл ведём МЫ: SDK должен вернуть первый ход (текст или запрос инструмента) и остановиться.
      maxTurns: 1,
      // Никаких встроенных инструментов Claude Code (Bash/Read/...): у Джарвиса свой арсенал и свои гейты.
      tools: [],
      ...(tools.length > 0
        ? {
            mcpServers: { [SERVER_NAME]: sdk.createSdkMcpServer({ name: SERVER_NAME, tools }) },
            allowedTools: [`${MCP_PREFIX}*`],
          }
        : {}),
      // §7/§2.7: размышление — по нашей пер-раундовой политике, а не по дефолту SDK.
      thinking: thinkingOption(req.thinking, req.tier),
      env,
      ...(onDelta ? { includePartialMessages: true } : {}),
    };
    // Потолок вывода хода: у SDK нет per-call параметра — он читается из env дочернего процесса.
    if (req.maxTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(req.maxTokens);

    let text = "";
    let streamed = "";
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    let errorText: string | undefined;

    // Зрение: есть картинки → streaming-input (блоки Messages API), иначе — обычный текстовый промпт.
    const transcript = serializeHistory(req);
    const images = collectImages(req);
    const prompt = images.length > 0 ? userMessageStream(transcript, images) : transcript;

    // 🔴 ГЛАВНЫЙ путь отказа — БРОШЕННОЕ исключение (ревью волны I): когда CLI выходит с ошибкой
    // (протухшая авторизация — самый частый случай), `sdk.query` бросает, а не отдаёт result-сообщение.
    // Классификация ниже стояла ТОЛЬКО после цикла, поэтому в реальном сценарии не выполнялась вовсе,
    // и владелец опять слышал «связь прервалась» вместо «нужно переавторизоваться».
    try {
      for await (const msg of sdk.query({ prompt, options })) {
      const type = String(msg.type ?? "");
      if (type === "stream_event" && onDelta) {
        const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
        const piece = ev?.delta?.type === "text_delta" ? (ev.delta.text ?? "") : "";
        if (piece) {
          streamed += piece;
          onDelta({ text: piece });
        }
        continue;
      }
      if (type === "assistant") {
        const content = (msg.message as { content?: unknown })?.content;
        text += extractText(content);
        const uses = extractToolUses(content);
        if (uses.length > 0) {
          captured.push(...uses);
          break; // исполняет НАШ agent-loop — дальше SDK не пускаем
        }
        continue;
      }
      if (type === "result") {
        const u = (msg.usage ?? {}) as Record<string, number>;
        // 🔴 ЖИВОЙ БАГ (боевой прогон 2026-08-31): у SDK ИНАЯ семантика usage — `input_tokens` почти
        // нулевой (видели 2), а `cache_*` кумулятивны по его внутренней сессии (68K+132K на 4-м
        // раунде). Наш гард контекст-окна складывает input+cache_read+cache_creation как РАЗМЕР
        // ПРОМПТА → 201K > HARD(185K) → задача обрывалась ложным «разрослась и не помещается» на
        // четвёртом шаге. Поэтому размер промпта в резерве ОЦЕНИВАЕМ САМИ по тому, что реально
        // отправили, а кеш-поля не выдаём за размер (в резерве нашего кеша нет вовсе — см. шапку).
        const sp = options.systemPrompt;
        const promptChars = (Array.isArray(sp) ? sp.join("\n\n") : String(sp ?? "")).length + transcript.length;
        usage = {
          inputTokens: Math.ceil(promptChars / 2.5), // 2.5 симв/ток — кириллическая калибровка проекта
          outputTokens: Number(u.output_tokens ?? 0),
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
        if (u.cache_read_input_tokens || u.cache_creation_input_tokens) {
          log.debug("резерв: кеш-числа SDK не используются как размер промпта", {
            sdkCacheRead: u.cache_read_input_tokens,
            sdkCacheCreation: u.cache_creation_input_tokens,
            ourEstimate: usage.inputTokens,
          });
        }
        // 🔴 `error_max_turns` — НЕ ошибка в нашей схеме: мы СПЕЦИАЛЬНО ставим maxTurns:1, чтобы
        // цикл вёл наш agent-loop, и SDK помечает так штатный случай «модель запросила инструмент
        // и остановилась» (поймано живым зондом). Ошибкой считаем только то, где мы ничего не
        // получили — иначе честный ход с инструментом превращался бы в стаб.
        const failed = msg.subtype && msg.subtype !== "success" && msg.subtype !== "error_max_turns";
        if (failed) errorText = String(msg.result ?? msg.subtype);
        if (!text && typeof msg.result === "string" && msg.subtype === "success") text = msg.result;
      }
      }
    } catch (e) {
      // Ничего не получили — это отказ канала, и владелец должен услышать ЕГО причину. Если же
      // модель успела дать текст или запросить инструмент, работу не выбрасываем: обрыв на хвосте
      // потока не повод превращать состоявшийся ход в стаб.
      if (captured.length === 0 && !text && !streamed) {
        const raw = e instanceof Error ? e.message : String(e);
        lastFailure = classifySubscriptionError(raw);
        log.warn("резерв недоступен (исключение SDK)", { kind: lastFailure.kind, human: lastFailure.human });
        throw new Error(`подписка: ${lastFailure.human}`);
      }
      log.warn("резерв: поток оборвался после частичного ответа — отдаю, что получил", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Ошибку поднимаем, только если ход ничего не дал: пришедший текст/вызов инструмента — уже
    // результат, и превращать его в стаб (потеря работы модели) было бы ложным провалом.
    if (errorText && captured.length === 0 && !text && !streamed) {
      lastFailure = classifySubscriptionError(errorText);
      log.warn("резерв недоступен", { kind: lastFailure.kind, human: lastFailure.human });
      throw new Error(`подписка: ${lastFailure.human}`);
    }
    // Ход прошёл — прежняя причина отказа больше не актуальна (иначе паспорт врал бы о мёртвом канале).
    lastFailure = undefined;
    // Стрим уже отдал текст наружу — не дублируем его в ответе иным содержимым (инвариант
    // «сумма дельт === resp.text» из контракта ILlmProvider).
    const finalText = onDelta && streamed ? streamed : text;
    const toolUses = dedupeById(captured);
    return {
      text: finalText.trim(),
      toolUses,
      stopReason: toolUses.length > 0 ? "tool_use" : "end_turn",
      usage,
      stubbed: false,
      channel: "subscription", // расход считается лимитами подписки, а не долларами API
    };
  }
}

/**
 * Один user-ход с блоками (текст + картинки) в формате streaming-input SDK. Генератор завершается
 * сразу: наш цикл ведёт агент-петля, продолжения диалога внутри SDK-сессии нам не нужны.
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

/** Уникальные вызовы по id (перехват может добавить их и из потока, и из хендлера). */
function dedupeById(uses: ToolUse[]): ToolUse[] {
  const seen = new Set<string>();
  return uses.filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)));
}

/**
 * Наши JSON-Schema-инструменты → инструменты SDK. `tool()` требует zod-shape, а у нас сырая JSON
 * Schema, поэтому объявляем ОДИН свободный параметр `args` и кладём настоящую схему в описание:
 * строгую валидацию всё равно делает наш dispatch, а модель видит поля из описания.
 * Хендлер не исполняет: если поток перехватить не удалось, он фиксирует вызов и честно сообщает
 * модели, что исполнение идёт на стороне Джарвиса.
 */
function buildTools(sdk: SdkModule, schemas: readonly ToolSchema[], captured: ToolUse[]): unknown[] {
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
      async (args: unknown) => {
        const a = (args ?? {}) as Record<string, unknown>;
        const input = (a.args && typeof a.args === "object" ? a.args : a) as Record<string, unknown>;
        captured.push({ id: newId(), name: s.name, input });
        return { content: [{ type: "text", text: "Принято: выполняет Джарвис." }] };
      },
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
