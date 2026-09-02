/**
 * Хендлеры ИСПОЛНЕНИЯ КОДА (§6) — вынесено из god-object dispatch.ts (§ревью).
 * code_run под серверным lint-гардом + единый `executeGuardedCode` (lint → confirm на необратимое → code.run).
 * `executeGuardedCode` переиспользует и самописный инструмент (runDynamicTool в dispatch) — гард не обойти.
 */
import { type CodeLang } from "@jarvis/protocol";
import { lintCode } from "../../code-guard.js";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { channelDownResult, confirmDeclineText, declined, gateDeclined, err, ok } from "../dispatch-util.js";

/** code.run под серверным lint-гардом (§6): запрет реестра/служб/сети/системных путей. */
export async function runCodeGuarded(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const lang = input.lang as CodeLang;
  const code = String(input.code ?? "");
  if (!["python", "node", "powershell"].includes(lang)) return err("code_run: неизвестный lang");
  if (!code.trim()) return err("code_run: пустой код");
  const opts: CodeRunOpts = {};
  const cwd = String(input.cwd ?? "").trim();
  if (cwd) opts.cwd = cwd;
  if (input.timeoutMs !== undefined && input.timeoutMs !== null && input.timeoutMs !== "") {
    const t = Number(input.timeoutMs);
    if (!Number.isFinite(t) || t < 1000) return err(`code_run: timeoutMs должен быть числом ≥1000 (мс), получено ${JSON.stringify(input.timeoutMs)}`);
    opts.timeoutMs = Math.min(180_000, Math.round(t));
  }
  if (input.background === true || input.background === "true") opts.background = true;
  return executeGuardedCode(ctx, lang, code, opts);
}

/** Параметры запуска (сценарии 2026-09-02, причина №2): каталог репозитория, окно запуска, фоновое задание. */
export interface CodeRunOpts {
  cwd?: string;
  timeoutMs?: number;
  background?: boolean;
}

/**
 * Единый гардированный путь исполнения кода (§6): lint → (powershell/необратимое: confirm) → code.run.
 * Используется и code_run, и самописными инструментами — самописный не обходит предохранители.
 */
export async function executeGuardedCode(ctx: ToolContext, lang: CodeLang, code: string, opts: CodeRunOpts = {}): Promise<ToolResult> {
  const lint = lintCode(lang, code);
  if (!lint.ok) {
    return err(`код отклонён гардом (§6): ${lint.violations.map((v) => v.message).join("; ")}`);
  }
  if (lint.requiresConfirm) {
    // §4: подтверждаем ТОЛЬКО необратимое (удаление файлов / форматирование диска). Всё прочее
    // управление Windows (реестр/службы/сеть/COM) идёт без модалки — автономия по решению пользователя.
    if (!ctx.confirm) return err("необратимая операция требует подтверждения (§4), но канал недоступен.");
    // Причина ПЕРЕД кодом: отправка письма (smtplib/Send-MailMessage) может стоять сороковой строкой,
    // а в модалку влезают лишь первые 160 символов — без причины владелец подтверждал бы вслепую (§3).
    const why = lint.confirmReasons.length > 0 ? `${lint.confirmReasons.join("; ")}\n\n` : "";
    const gate = await ctx.confirm(`Выполнить код?\n${why}${code.slice(0, 160)}${code.length > 160 ? "…" : ""}`, "irreversible");
    if (!gate.approved) return gateDeclined(confirmDeclineText(gate.outcome, "code.run"), gate.outcome);
  }
  // Таймаут с запасом над окном раннера (явный timeoutMs или макс. 180с): раннер сам убьёт зависший процесс
  // по своему wall-clock. Фоновое задание отвечает сразу (spawn) — короткое окно.
  const actionTimeout = opts.background ? 20_000 : (opts.timeoutMs ?? 180_000) + 5_000;
  const result = await ctx.session.sendAction(
    { kind: "code.run", lang, code, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.background ? { background: true } : {}) },
    actionTimeout,
  );
  if (result.ok) {
    if (opts.background) {
      return ok(
        `Фоновое задание ЗАПУЩЕНО: ${result.data !== undefined ? JSON.stringify(result.data) : "ok"}. ИСХОД ЕЩЁ НЕ ИЗВЕСТЕН — не говори «готово»: ` +
          `опрашивай job_status{jobId} (running:false + exitCode) или жди wait_for{kind:"process", pid, gone:true} / wait_for{kind:"file", path, stableMs}; результат сверяй по файлу/выводу.`,
      );
    }
    return ok(result.data !== undefined ? JSON.stringify(result.data) : "ok (code.run)");
  }
  const cd = channelDownResult(result, "code.run не отправлен: канал с ПК недоступен (переподключение)."); // Б4 #4
  if (cd) return cd;
  return err(`code.run не удалось: ${result.error?.code ?? "runtime"} ${result.error?.message ?? ""}`);
}
