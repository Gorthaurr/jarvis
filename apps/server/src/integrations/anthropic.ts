/**
 * LLM-провайдер Anthropic с поддержкой tool-use (§7, §8, §15).
 *
 * Реализует ILlmProvider (llm.ts). Реальный вызов через @anthropic-ai/sdk при
 * наличии ANTHROPIC_API_KEY; иначе — детерминированный стаб (без сети, без tool-use).
 * Первый системный блок (персона) помечается cache_control (§15). SDK импортируется
 * динамически — отсутствие пакета не ломает импорт модуля.
 */
import { type Logger, type ThinkingEffort, backoffMs, createLogger, sleep } from "@jarvis/shared";
import type {
  ILlmProvider,
  LlmContentBlock,
  LlmDelta,
  LlmRequest,
  LlmResponse,
  StopReason,
  ToolUse,
} from "./llm.js";

const log: Logger = createLogger("llm:anthropic");

/** Параметр thinking Anthropic из «эффорта» тира (модель-aware, по живому зонду 2026-06-24). */
type ThinkingParam = { type: "adaptive" } | { type: "enabled"; budget_tokens: number };
export function thinkingArg(effort: ThinkingEffort | undefined, model: string): ThinkingParam | undefined {
  if (!effort || effort === "off") return undefined;
  const isOpus = /opus/i.test(model);
  // Opus 4.8 = adaptive-thinking-only (enabled/budget → 400). Sonnet 4.6 = adaptive ИЛИ enabled+budget.
  if (effort === "adaptive") return { type: "adaptive" };
  if (typeof effort === "number") return isOpus ? { type: "adaptive" } : { type: "enabled", budget_tokens: effort };
  return undefined;
}

export interface AnthropicConfig {
  apiKey: string | undefined;
  maxRetries?: number;
  /** TTL prompt-кеша (§15): "5m" (дефолт) или "1h" (extended, beta-заголовок). */
  cacheTtl?: "5m" | "1h";
  /** Base URL — для шлюза/прокси (proxyapi.ru и т.п.); по умолчанию прямой Anthropic. */
  baseUrl?: string;
}

/** Сырые типы ответа SDK (минимально). */
interface RawContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  /** extended thinking: текст размышления + подпись (нужно вернуть в историю при tool-use). */
  thinking?: string;
  signature?: string;
  /** redacted_thinking: зашифрованный блок размышления. */
  data?: string;
}
interface RawResponse {
  content: RawContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Минимальный контракт MessageStream SDK (§10), который мы реально используем. */
interface RawMessageStream {
  on(event: "text", cb: (delta: string) => void): RawMessageStream;
  on(event: "error", cb: (err: unknown) => void): RawMessageStream;
  finalMessage(): Promise<RawResponse>;
  /** Прервать стрим (SDK MessageStream.abort) — для watchdog «стрим завис». */
  abort?(): void;
}

/** Поверхность SDK-клиента, которой мы пользуемся (create + stream). */
interface RawAnthropicClient {
  messages: {
    create(args: unknown, opts?: unknown): Promise<RawResponse>;
    stream(args: unknown, opts?: unknown): RawMessageStream;
  };
}

/**
 * Потолок вывода за ОДИН ход (output-токены, НЕ размер контекста — контекст у Opus ~200K).
 * Env JARVIS_MAX_OUTPUT_TOKENS (деф 8192, кламп [256, 64000]). Это КАП, не цель: короткие реплики
 * стопаются на end_turn раньше и не страдают по латентности; длинный вывод (код/документ) реже
 * упирается. Очень большой вывод докручивается continuation'ом в agent-loop и/или пишется в файл.
 */
const MAX_OUTPUT_TOKENS_DEFAULT = (() => {
  const n = Number.parseInt(process.env.JARVIS_MAX_OUTPUT_TOKENS ?? "", 10);
  return Number.isFinite(n) && n >= 256 && n <= 64_000 ? n : 8192;
})();

export class AnthropicLlmProvider implements ILlmProvider {
  readonly live: boolean;
  private readonly apiKey: string | undefined;
  private readonly maxRetries: number;
  private readonly cacheTtl: "5m" | "1h";
  private readonly baseUrl: string | undefined;
  private clientPromise: Promise<unknown> | null = null;

  constructor(cfg: AnthropicConfig) {
    this.apiKey = cfg.apiKey;
    // Голос: быстро падать, а не висеть. 1 ретрай (транзиентный блип), не 3 —
    // мёртвый шлюз не должен тормозить ответ на 6.5с (см. грабли oneprovider).
    this.maxRetries = cfg.maxRetries ?? 1;
    this.cacheTtl = cfg.cacheTtl ?? "5m";
    this.baseUrl = cfg.baseUrl;
    this.live = Boolean(cfg.apiKey);
    if (!this.live) log.warn("ANTHROPIC_API_KEY не задан — LLM в стаб-режиме");
    else if (this.baseUrl) log.info("LLM через шлюз", { baseUrl: this.baseUrl });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.live) return stub(req);

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.callReal(req);
      } catch (e) {
        lastErr = e;
        // Детерминированную 4xx (invalid_request: протёкший sampling-параметр/неверный model id и т.п.)
        // ретраить бессмысленно — повторится идентично. Падаем в стаб СРАЗУ (голос: быстро падать).
        if (!isRetryable(e)) {
          log.error("LLM-вызов не удался (неретраябельно) — стаб", {
            status: (e as { status?: number })?.status,
            error: e instanceof Error ? e.message : String(e),
          });
          return stub(req);
        }
        // Спим ТОЛЬКО если впереди есть ещё попытка — иначе это чистая лишняя задержка перед стабом.
        if (attempt < this.maxRetries) {
          const wait = backoffMs(attempt);
          log.warn("LLM-вызов не удался, ретрай", { attempt, waitMs: wait });
          await sleep(wait);
        }
      }
    }
    log.error("LLM недоступен после ретраев — стаб", {
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    });
    return stub(req);
  }

  /**
   * Стрим генерации (§10 realtime): текст идёт дельтами в onDelta. Стрим+ретрай
   * некогерентны (нельзя «отыграть» уже отданные дельты), поэтому одна попытка:
   *  - падение ДО первой дельты → фолбэк на complete() (со своими ретраями/стабом),
   *    его текст отдаём одной дельтой (инвариант «сумма дельт === resp.text» цел);
   *  - падение ПОСЛЕ дельт → возвращаем накопленный текст как end_turn (без двойного
   *    голоса и без регенерации). Редкий путь, логируем.
   */
  async completeStream(req: LlmRequest, onDelta: (d: LlmDelta) => void): Promise<LlmResponse> {
    if (!this.live) {
      const s = stub(req);
      if (s.text) onDelta({ text: s.text });
      return s;
    }
    let acc = "";
    try {
      return await this.callRealStream(req, (d) => {
        acc += d.text;
        onDelta(d);
      });
    } catch (e) {
      log.warn("LLM-стрим не удался", { error: e instanceof Error ? e.message : String(e) });
      if (acc.length > 0) {
        // Уже стримили часть — не регенерируем (двойной голос): отдаём, что есть.
        return {
          text: acc,
          toolUses: [],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          stubbed: false,
        };
      }
      const resp = await this.complete(req);
      if (resp.text) onDelta({ text: resp.text });
      return resp;
    }
  }

  private async callReal(req: LlmRequest): Promise<LlmResponse> {
    const client = (await this.getClient()) as RawAnthropicClient;
    const resp = await client.messages.create(this.buildArgs(req), this.buildOpts());
    return parseResponse(resp);
  }

  private async callRealStream(
    req: LlmRequest,
    onDelta: (d: LlmDelta) => void,
  ): Promise<LlmResponse> {
    const client = (await this.getClient()) as RawAnthropicClient;
    const stream = client.messages.stream(this.buildArgs(req), this.buildOpts());
    // WATCHDOG зависшего стрима: SDK `timeout` ловит только СТАРТ ответа, а не паузу МЕЖДУ
    // токенами. На сетевом сбое посреди стрима (типично за VPN из РФ) `finalMessage()` иначе
    // ждёт вечно → задача висит в «выполняю», панель не закрывается. Таймер сбрасывается на
    // каждом токене (длинная генерация ОК, пока токены идут); тишина дольше порога → abort →
    // finalMessage реджектит → completeStream фолбэчит (частичный текст / стаб). env-тюнинг.
    const stallMs = streamStallMs();
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        try {
          stream.abort?.();
        } catch {
          /* стрим уже завершён */
        }
      }, stallMs);
      timer.unref?.();
    };
    arm();
    stream.on("text", (delta: string) => {
      arm(); // токен пришёл — продлеваем окно
      if (delta) onDelta({ text: delta });
    });
    try {
      // finalMessage() реджектит при ошибке/аборте — пробрасываем наверх в completeStream.
      const final = await stream.finalMessage();
      return parseResponse(final);
    } catch (e) {
      if (stalled) throw new Error("LLM-стрим завис (нет токенов дольше таймаута)");
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Тело запроса к messages.create/stream — общее (§15-кеш, без sampling-параметров). */
  private buildArgs(req: LlmRequest): unknown {
    const cacheControl: EphemeralCache =
      this.cacheTtl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
    const system = buildSystemBlocks(req, cacheControl);

    // «Эффорт» = thinking (живой зонд: effort/reasoning_effort API не принимает). Модель-aware:
    // Opus 4.8 = только adaptive; Sonnet 4.6 = adaptive ИЛИ enabled+budget. off → без thinking.
    const think = thinkingArg(req.thinking, req.model);
    let maxTokens = req.maxTokens ?? MAX_OUTPUT_TOKENS_DEFAULT;
    // enabled-thinking: max_tokens ДОЛЖЕН быть строго больше budget_tokens (требование API).
    if (think && think.type === "enabled" && maxTokens <= think.budget_tokens) {
      maxTokens = think.budget_tokens + 2048;
    }

    return {
      model: req.model,
      // Потолок ВЫВОДА за ход (не контекст). Деф env (8192) — с запасом для кода/документа;
      // обрыв по лимиту докручивается continuation'ом в agent-loop. Латентность не страдает:
      // это кап, реплика стопается на end_turn раньше, а первый звук идёт стримом фразы.
      max_tokens: maxTokens,
      ...(think ? { thinking: think } : {}),
      // ВНИМАНИЕ: НЕ слать temperature/top_p/top_k. На Opus 4.8 / 4.7 / Fable 5 эти
      // sampling-параметры УДАЛЕНЫ — любой из них → HTTP 400 (invalid_request_error)
      // → стаб «Модель не подключена». (Гейт oneprovider их глотал, реальный Anthropic — нет.)
      // Поведение модели рулим персоной (§11), не temperature.
      system,
      // Блоки messages могут нести cache_control (брейкпоинт растущего диалога
      // в agent-loop, §15) — пробрасываем как есть.
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.input_schema,
            })),
          }
        : {}),
    };
  }

  /** Опции запроса: extended-cache 1h требует beta-заголовка (§15). */
  private buildOpts(): unknown {
    return this.cacheTtl === "1h"
      ? { headers: { "anthropic-beta": "extended-cache-ttl-2025-04-11" } }
      : undefined;
  }

  private getClient(): Promise<unknown> {
    if (this.clientPromise) return this.clientPromise;
    // Если импорт/инициализация SDK упадёт — НЕ кешируем отклонённый промис навсегда (иначе
    // разовый транзиентный сбой вырубает live-LLM до перезапуска). Сбрасываем, чтобы повторить.
    const p = (async () => {
      const spec = "@anthropic-ai/sdk";
      const mod = await import(spec);
      const Anthropic = (mod.default ?? (mod as { Anthropic?: unknown }).Anthropic) as new (
        opts: { apiKey: string; baseURL?: string; maxRetries?: number; timeout?: number },
      ) => unknown;
      return new Anthropic({
        apiKey: this.apiKey!,
        // Ретраи делаем сами (короткие). Внутренние ретраи SDK (дефолт 2) умножали
        // задержку на дохлом шлюзе → отключаем.
        maxRetries: 0,
        // timeout — общий потолок ОДНОГО HTTP-вызова. Раньше 10с — слишком жёстко для НЕ-стримового
        // complete() под тяжёлым кеш-промптом (54–84k cache-read токенов) + параллельными фоновыми
        // задачами → `Request timed out` → стаб «связь прервалась» вместо реального ответа (живой лог
        // QA 2026-06-21). Голосовой латентности это НЕ вредит: completeStream защищён отдельным
        // stall-watchdog (нет токенов дольше JARVIS_LLM_STREAM_STALL_MS=25с → abort), который сработает
        // РАНЬШЕ этого потолка. env JARVIS_LLM_TIMEOUT_MS, дефолт 60с, кламп [10с, 180с].
        timeout: llmTimeoutMs(),
        ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
      });
    })();
    // Кешируем промис, но при отклонении — сбрасываем, чтобы следующий вызов попробовал заново.
    p.catch(() => {
      if (this.clientPromise === p) this.clientPromise = null;
    });
    this.clientPromise = p;
    return p;
  }
}

/** Тип эфемерного кеш-контроля Anthropic (5m по умолчанию / 1h extended). */
type EphemeralCache = { type: "ephemeral"; ttl?: "1h" };
type SystemBlock = { type: "text"; text: string; cache_control?: EphemeralCache };

/**
 * Собрать системные блоки запроса с кеш-брейкпоинтами (§15). Чистая функция — тестируется
 * напрямую (раньше эта логика жила приватно в buildArgs и не покрывалась тестами).
 *
 * Порядок и кеширование (в каноническом порядке tools → system → messages):
 *   1) ПЕРСОНА (systemStatic) — кеш-брейкпоинт: кеширует tools+персону, стабилен между задачами.
 *   2) НАВЫК (systemSkill, §8) — ОТДЕЛЬНЫЙ брейкпоинт после персоны: пока навык тот же, читается
 *      из кеша (cache_read ~0.1×), а не шлётся полным текстом каждый ход многоходовой задачи.
 *   3) ДИНАМИКА (systemDynamic) — БЕЗ кеша: имя/факты/контекст/окружение/тон меняются по ходам,
 *      поэтому идут ПОСЛЕ кешируемых блоков и не ломают их кеш-хит.
 * cachePrefix===false (разовая команда вне сессии) → все блоки без cache_control (не платим 1.25×).
 */
export function buildSystemBlocks(
  req: Pick<LlmRequest, "systemStatic" | "systemSkill" | "systemTools" | "systemDynamic" | "cachePrefix">,
  cacheControl: EphemeralCache,
): SystemBlock[] {
  const cache = req.cachePrefix === false ? undefined : cacheControl;
  const block = (text: string, cached: boolean): SystemBlock =>
    cached && cache ? { type: "text", text, cache_control: cache } : { type: "text", text };
  const blocks: SystemBlock[] = [block(req.systemStatic, true)];
  // §15: каталог холодных инструментов — ОТДЕЛЬНЫЙ кеш-брейкпоинт после персоны (меняется редко). Anthropic
  // допускает до 4 cache breakpoints: персона + каталог + навык + rolling(в messages) = ровно 4.
  if (req.systemTools) blocks.push(block(req.systemTools, true));
  if (req.systemSkill) blocks.push(block(req.systemSkill, true)); // §8: навык — свой кеш-брейкпоинт
  if (req.systemDynamic) blocks.push(block(req.systemDynamic, false)); // динамика — без кеша
  return blocks;
}

/** Разобрать ответ SDK в LlmResponse (чистая функция — тестируется отдельно). */
export function parseResponse(resp: RawResponse): LlmResponse {
  const toolUses: ToolUse[] = [];
  const thinkingBlocks: LlmContentBlock[] = [];
  let text = "";
  for (const b of resp.content ?? []) {
    if (b.type === "text" && b.text) text += b.text;
    else if (b.type === "tool_use" && b.id && b.name) {
      toolUses.push({ id: b.id, name: b.name, input: b.input ?? {} });
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      // Сохраняем дословно с подписью — agent-loop вернёт ПЕРВЫМИ в assistant-ход при tool-use.
      thinkingBlocks.push({ type: "thinking", thinking: b.thinking, signature: b.signature ?? "" });
    } else if (b.type === "redacted_thinking" && typeof b.data === "string") {
      thinkingBlocks.push({ type: "redacted_thinking", data: b.data });
    }
  }
  const stopReason: StopReason =
    resp.stop_reason === "tool_use"
      ? "tool_use"
      : resp.stop_reason === "max_tokens"
        ? "max_tokens"
        : "end_turn";
  return {
    text,
    toolUses,
    stopReason,
    usage: {
      inputTokens: resp.usage?.input_tokens ?? 0,
      outputTokens: resp.usage?.output_tokens ?? 0,
      cacheReadTokens: resp.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: resp.usage?.cache_creation_input_tokens ?? 0,
    },
    stubbed: false,
    ...(thinkingBlocks.length ? { thinkingBlocks } : {}),
  };
}

/** Стаб без сети (нет ключа / шлюз недоступен): короткое произносимое сообщение, без tool-use. */
function stub(_req: LlmRequest): LlmResponse {
  return {
    // Уходит в TTS → чисто и в характере, без debug-префикса и эха запроса.
    text: "Связь с сервером прервалась, сэр. Повторите, пожалуйста.",
    toolUses: [],
    stopReason: "stub",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    stubbed: true,
  };
}

/**
 * Порог «стрим завис» (мс): нет ни одного токена дольше этого → считаем соединение мёртвым и
 * абортим (env JARVIS_LLM_STREAM_STALL_MS, дефолт 25с — с запасом на «думающую» паузу Opus,
 * но не вечность). Кламп [5с, 120с].
 */
function streamStallMs(): number {
  const n = Number.parseInt(process.env.JARVIS_LLM_STREAM_STALL_MS ?? "", 10);
  return Number.isFinite(n) ? Math.min(120_000, Math.max(5_000, n)) : 25_000;
}

/**
 * Общий таймаут одного HTTP-вызова к Anthropic (мс). НЕ-стримовый complete() (фоновые итоги/
 * continuation) под тяжёлым кеш-промптом не укладывался в прежние 10с → ложный стаб. Дефолт 60с,
 * env JARVIS_LLM_TIMEOUT_MS, кламп [10с, 180с]. Голос защищён stall-watchdog'ом отдельно.
 */
function llmTimeoutMs(): number {
  const n = Number.parseInt(process.env.JARVIS_LLM_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(n) ? Math.min(180_000, Math.max(10_000, n)) : 60_000;
}

/**
 * Стоит ли ретраить ошибку LLM. Транзиентные (сеть/таймаут/5xx/429/408) — да; детерминированные
 * 4xx (invalid_request_error и пр.) повторятся идентично → нет смысла ждать и жечь время.
 * SDK-ошибка несёт числовой `status` (duck-typing: динамический импорт SDK, instanceof недоступен).
 */
function isRetryable(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  if (typeof status !== "number") return true; // сеть/таймаут/неизвестное — ретраябельно
  if (status === 408 || status === 429) return true; // таймаут/лимит — транзиентно
  return status < 400 || status >= 500; // 5xx — транзиентно; прочие 4xx — нет
}
