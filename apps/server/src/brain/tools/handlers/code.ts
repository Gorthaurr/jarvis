/**
 * Хендлеры ИСПОЛНЕНИЯ КОДА (§6) — вынесено из god-object dispatch.ts (§ревью).
 * code_run под серверным lint-гардом + единый `executeGuardedCode` (lint → confirm на необратимое → code.run).
 * `executeGuardedCode` переиспользует и самописный инструмент (runDynamicTool в dispatch) — гард не обойти.
 */
import { type CodeLang } from "@jarvis/protocol";
import { lintCode } from "../../code-guard.js";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { err, ok } from "../dispatch-util.js";

/** code.run под серверным lint-гардом (§6): запрет реестра/служб/сети/системных путей. */
export async function runCodeGuarded(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const lang = input.lang as CodeLang;
  const code = String(input.code ?? "");
  if (!["python", "node", "powershell"].includes(lang)) return err("code_run: неизвестный lang");
  if (!code.trim()) return err("code_run: пустой код");
  return executeGuardedCode(ctx, lang, code);
}

/**
 * Единый гардированный путь исполнения кода (§6): lint → (powershell/необратимое: confirm) → code.run.
 * Используется и code_run, и самописными инструментами — самописный не обходит предохранители.
 */
export async function executeGuardedCode(ctx: ToolContext, lang: CodeLang, code: string): Promise<ToolResult> {
  const lint = lintCode(lang, code);
  if (!lint.ok) {
    return err(`код отклонён гардом (§6): ${lint.violations.map((v) => v.message).join("; ")}`);
  }
  if (lint.requiresConfirm) {
    // §4: подтверждаем ТОЛЬКО необратимое (удаление файлов / форматирование диска). Всё прочее
    // управление Windows (реестр/службы/сеть/COM) идёт без модалки — автономия по решению пользователя.
    if (!ctx.confirm) return err("необратимая операция требует подтверждения (§4), но канал недоступен.");
    const { approved } = await ctx.confirm(`Выполнить код?\n${code.slice(0, 160)}${code.length > 160 ? "…" : ""}`, "irreversible");
    if (!approved) return ok("Отменено пользователем (code.run).");
  }
  // Таймаут с запасом над макс. окном раннера (180с): раннер сам убьёт зависший процесс по своему wall-clock.
  const result = await ctx.session.sendAction({ kind: "code.run", lang, code }, 185_000);
  if (result.ok) return ok(result.data !== undefined ? JSON.stringify(result.data) : "ok (code.run)");
  return err(`code.run не удалось: ${result.error?.code ?? "runtime"} ${result.error?.message ?? ""}`);
}
