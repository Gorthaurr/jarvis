/**
 * «Не проверяется в лаборатории: причина». Инструмент, которому нужен внешний мир, которого лаборатория не подключила
 * (Chrome-расширение, MCP, рынок, чужая почта), НЕ диспетчеризуется: иначе честная ошибка «сервис не сконфигурирован»
 * читалась бы как результат проверки. Лимит снимается, когда нужная часть ЯВНО передана в ctx (мок ext и т.п.).
 */
import type { ToolContext } from "../../../apps/server/src/brain/tools/dispatch.js";

const EXT_TOOLS: ReadonlySet<string> = new Set([
  "browser_open", "browser_act", "browser_batch", "browser_read", "browser_inspect", "browser_tabs", "browser_close",
  "browser_sync_login", "mail_read", "calendar_read",
]);
const MARKET_TOOLS: ReadonlySet<string> = new Set([
  "market_quote", "market_candles", "market_analyze", "market_backtest", "market_news", "tinkoff_portfolio",
  "trade_predict", "trade_winrate", "trade_predictions",
]);

export const NOT_VERIFIABLE_PREFIX = "не проверяется в лаборатории";

type Check = (tool: string, args: Record<string, unknown>, ctx: Partial<ToolContext>) => string | null;

const CHECKS: Check[] = [
  // Безусловные: побочка выходит за песочницу.
  (t) => (t === "self_patch" ? "правит исходники и ветки РЕПОЗИТОРИЯ (git merge) — в лаборатории запрещено" : null),
  (t) => (t === "mail_send" ? "реальный SMTP/IMAP владельца (MAIL_* из .env) — письма в лаборатории не отправляем" : null),
  // Условные: снимаются подключением части в ctx.
  (t, _a, c) => (EXT_TOOLS.has(t) && !c.ext ? "нужен Chrome+расширение (ctx.ext): стенд infra/bench либо мок ext, переданный в createToolLab({ ctx: { ext } })" : null),
  (t, a, c) =>
    t === "wait_for" && (a.condition as { kind?: unknown } | undefined)?.kind === "browser" && !c.ext
      ? "wait_for{browser} читает вкладку через расширение (ctx.ext)"
      : null,
  (t, _a, c) => (t.startsWith("mcp__") && !c.mcp ? "нужен MCP-хост (ctx.mcp) с подключёнными серверами" : null),
  (t, _a, c) => (MARKET_TOOLS.has(t) && !c.market ? "нужен сервис рынка (ctx.market): внешние котировки/ключи, сети в лаборатории нет" : null),
  (t, _a, c) => (t === "knowledge_consult" && !c.knowledge ? "нужна база знаний (ctx.knowledge)" : null),
  (t, _a, c) => (t === "telegram_send_voice" && !(c.synthVoice && c.telegramSendVoice) ? "нужны TTS и расширение Telegram (ctx.synthVoice, ctx.telegramSendVoice)" : null),
];

/** Причина, по которой вызов нельзя честно проверить в лаборатории; null — можно. */
export function labLimit(tool: string, args: Record<string, unknown>, ctx: Partial<ToolContext>): string | null {
  for (const check of CHECKS) {
    const why = check(tool, args, ctx);
    if (why) return why;
  }
  return null;
}
