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
import { z } from "zod";
import { newId } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import type { ToolSchema } from "@jarvis/tools";
import type { ILlmProvider, LlmDelta, LlmRequest, LlmResponse, ToolUse } from "./llm.js";

const log: Logger = createLogger("llm:subscription");

/** Префикс, который SDK даёт инструментам нашего in-process MCP-сервера. */
const MCP_PREFIX = "mcp__jarvis__";
const SERVER_NAME = "jarvis";

/** Токен headless-доступа к подписке (claude setup-token). Пусто → резерв недоступен. */
function oauthToken(): string | undefined {
  const t = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  return t ? t : undefined;
}

/** Резерв включён? (env JARVIS_SUBSCRIPTION_FALLBACK=0 выключает даже при наличии токена.) */
export function subscriptionFallbackEnabled(): boolean {
  return process.env.JARVIS_SUBSCRIPTION_FALLBACK !== "0";
}

/**
 * Модель для SDK: наш model id («claude-sonnet-4-6») SDK принимает, но у подписки свой набор —
 * безопаснее передавать алиас по тиру (sonnet/opus), как это делает Claude Code.
 */
function modelAlias(req: LlmRequest): string {
  if (req.tier === "fable") return "opus";
  return req.model.includes("opus") ? "opus" : "sonnet";
}

/** Собрать системный промпт из наших блоков (кеш-брейкпоинты в резерве не применимы — см. шапку). */
function buildSystem(req: LlmRequest): string {
  return [req.systemStatic, req.systemSkill, req.systemTools, req.systemDynamic].filter((s) => s && s.trim()).join("\n\n");
}

/** Текст из блока результата инструмента (картинки в резерве обозначаем меткой — их SDK не примет). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((b) => {
      const blk = b as { type?: string; text?: string };
      if (blk.type === "text") return blk.text ?? "";
      if (blk.type === "image") return "[картинка — в резервном режиме не передаётся]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
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
        parts.push("### СКРИНШОТ\n[картинка — в резервном режиме не передаётся]");
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
  query: (opts: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>;
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
   * Резерв доступен? Требуется ЯВНЫЙ headless-токен подписки: сохранённый интерактивный логин
   * (~/.claude/.credentials.json) в фоновом сервисе протухает и не рефрешится — молча обещать по нему
   * работу нельзя (проверено живым зондом: «OAuth session expired and could not be refreshed»).
   */
  get live(): boolean {
    return subscriptionFallbackEnabled() && oauthToken() !== undefined;
  }

  /** Понятная причина недоступности — для честного ответа владельцу и boot-лога. */
  static unavailableReason(): string | undefined {
    if (!subscriptionFallbackEnabled()) return "резерв по подписке выключен (JARVIS_SUBSCRIPTION_FALLBACK=0)";
    if (!oauthToken()) {
      return "нет токена подписки: выполните `claude setup-token` и положите CLAUDE_CODE_OAUTH_TOKEN в .env";
    }
    return undefined;
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
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: oauthToken() };
    delete env.ANTHROPIC_API_KEY;

    const options: Record<string, unknown> = {
      systemPrompt: buildSystem(req),
      model: modelAlias(req),
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
      env,
      ...(onDelta ? { includePartialMessages: true } : {}),
    };

    let text = "";
    let streamed = "";
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    let errorText: string | undefined;

    for await (const msg of sdk.query({ prompt: serializeHistory(req), options })) {
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
        usage = {
          inputTokens: Number(u.input_tokens ?? 0),
          outputTokens: Number(u.output_tokens ?? 0),
          cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
          cacheCreationTokens: Number(u.cache_creation_input_tokens ?? 0),
        };
        if (msg.subtype && msg.subtype !== "success") errorText = String(msg.result ?? msg.subtype);
        if (!text && typeof msg.result === "string" && msg.subtype === "success") text = msg.result;
      }
    }

    if (errorText) throw new Error(`подписка: ${errorText}`);
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
    };
  }
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
  return schemas.map((s) =>
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
