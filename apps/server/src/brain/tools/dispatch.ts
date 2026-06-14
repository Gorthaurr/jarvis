/**
 * Диспетчер инструментов agent-loop (§6, §8, §12).
 *
 * Маппит tool-use от LLM на исполнение:
 *  - актуаторные инструменты → ActionCommand клиенту (session.sendAction);
 *  - server-side инструменты мозга → web.search/web.fetch, memory.search/write (§12, §8);
 *  - message_send/order_place → отложены до M6/M7 (требуют confirm + cadence/spend guard §14).
 *
 * Возвращает текст для tool_result и флаг ошибки. Декуплен от Session минимальным
 * интерфейсом ActuatorSink — тестируется с моком.
 */
import type { ActionCommand, ActionResult, ActionKind, CodeLang, MessageChannel } from "@jarvis/protocol";
import { DEFAULT_ACTION_TIMEOUT_MS } from "@jarvis/protocol";
import { ACTUATOR_TOOL_BY_KIND } from "@jarvis/tools";
import type { EpisodicMemory } from "../../memory/episodic.js";
import type { IWebProvider } from "../../integrations/web.js";
import { lintCode } from "../code-guard.js";
import { CadenceGuard } from "../messaging/cadence.js";
import { sendOutbound } from "../messaging/outbound.js";

/** Минимальный приёмник действий (реализует Session). */
export interface ActuatorSink {
  sendAction(cmd: ActionCommand, timeoutMs?: number): Promise<ActionResult>;
}

export interface ToolContext {
  session: ActuatorSink;
  web: IWebProvider;
  episodic: EpisodicMemory;
  userId: string;
  /** Подтверждение необратимого (§14). Нужен для message_send. */
  confirm?: (summary: string) => Promise<{ approved: boolean; revision?: string }>;
}

/** Cadence/идемпотентность переписки — на процесс (per-user внутри, §14). */
const cadence = new CadenceGuard();
const sentKeys = new Set<string>();

export interface ToolResult {
  content: string;
  isError: boolean;
}

/** tool name → ActionKind (реверс ACTUATOR_TOOL_BY_KIND). */
const KIND_BY_TOOL: Record<string, ActionKind> = Object.fromEntries(
  (Object.entries(ACTUATOR_TOOL_BY_KIND) as [ActionKind, string][]).map(([kind, tool]) => [tool, kind]),
) as Record<string, ActionKind>;

/** Инструменты, отложенные до M7 (необратимые, требуют гардов §14). */
const DEFERRED_TOOLS = new Set(["order_place"]);

export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Server-side инструменты мозга (§12, §8).
  switch (name) {
    case "web_search":
      return webSearch(ctx, input);
    case "web_fetch":
      return webFetch(ctx, input);
    case "memory_search":
      return memorySearch(ctx, input);
    case "memory_write":
      return memoryWrite(ctx, input);
    case "message_send":
      return messageSend(ctx, input);
  }

  if (DEFERRED_TOOLS.has(name)) {
    return err(`Инструмент ${name} требует подтверждения и гардов (§14) — будет доступен в M6/M7.`);
  }

  // code.run — серверный lint-гард ДО отправки клиенту (§6, §14).
  if (name === "code_run") return runCodeGuarded(ctx, input);

  // Актуаторные инструменты → ActionCommand клиенту.
  const kind = KIND_BY_TOOL[name];
  if (!kind) return err(`Неизвестный инструмент: ${name}`);

  const command = { kind, ...input } as ActionCommand;
  const result = await ctx.session.sendAction(command, DEFAULT_ACTION_TIMEOUT_MS);
  if (result.ok) {
    return ok(result.data !== undefined ? JSON.stringify(result.data) : `ok (${kind})`);
  }
  return err(`Действие ${kind} не удалось: ${result.error?.code ?? "runtime"} ${result.error?.message ?? ""}`);
}

async function webSearch(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const q = String(input.query ?? "").trim();
  if (!q) return err("web_search: пустой query");
  const limit = typeof input.limit === "number" ? input.limit : 5;
  const hits = await ctx.web.search(q, limit);
  if (hits.length === 0) return ok("Ничего не найдено (или web-провайдер в стаб-режиме).");
  return ok(hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n"));
}

async function webFetch(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const url = String(input.url ?? "").trim();
  if (!url) return err("web_fetch: пустой url");
  const page = await ctx.web.fetch(url);
  if (!page) return err("Не удалось загрузить страницу.");
  return ok(`# ${page.title}\n${page.text}`);
}

async function memorySearch(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const q = String(input.query ?? "").trim();
  if (!q) return err("memory_search: пустой query");
  const k = typeof input.k === "number" ? input.k : 5;
  const hits = await ctx.episodic.search(ctx.userId, q, k);
  if (hits.length === 0) return ok("В памяти ничего релевантного не найдено.");
  return ok(hits.map((h) => `- ${h.episode.text} (${h.score.toFixed(2)})`).join("\n"));
}

/** message.send под гардами §14: confirm (revise-петля) + cadence + idempotency (UC-2). */
async function messageSend(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.confirm) return err("отправка недоступна: нет канала подтверждения (§14)");
  const channel = input.channel as MessageChannel;
  const to = String(input.to ?? "").trim();
  const body = String(input.body ?? "").trim();
  if (channel !== "vk" && channel !== "telegram") return err("message_send: неизвестный channel");
  if (!to || !body) return err("message_send: нужны to и body");

  const res = await sendOutbound(
    { userId: ctx.userId, channel, recipient: to, body, neverMessagedBefore: true },
    {
      requestConfirm: (summary) => ctx.confirm!(summary),
      regenerate: async (_rev, prev) => prev, // полная перегенерация — через новый ход агента
      cadence,
      isAlreadySent: (k) => sentKeys.has(k),
      markSent: (k) => sentKeys.add(k),
      send: async (ch, rcpt, b) => {
        const r = await ctx.session.sendAction({ kind: "message.send", channel: ch, to: rcpt, body: b }, DEFAULT_ACTION_TIMEOUT_MS);
        return { ok: r.ok, error: r.error?.message };
      },
    },
  );
  if (res.status === "sent") return ok(`Отправлено ${to}.`);
  return err(`Не отправлено (${res.status}): ${res.reason ?? ""}`);
}

/** code.run под серверным lint-гардом (§6): запрет реестра/служб/сети/системных путей. */
async function runCodeGuarded(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const lang = input.lang as CodeLang;
  const code = String(input.code ?? "");
  if (!["python", "node", "powershell"].includes(lang)) return err("code_run: неизвестный lang");
  if (!code.trim()) return err("code_run: пустой код");

  const lint = lintCode(lang, code);
  if (!lint.ok) {
    return err(`code.run отклонён гардом (§6): ${lint.violations.map((v) => v.message).join("; ")}`);
  }
  if (lint.requiresConfirm) {
    // §6: powershell ВСЕГДА требует confirm + CLM. Подтверждение в автоцикле — §14/M8.
    return err("powershell требует подтверждения пользователя (§6) — недоступен в автоцикле без confirm.");
  }
  const result = await ctx.session.sendAction({ kind: "code.run", lang, code }, DEFAULT_ACTION_TIMEOUT_MS);
  if (result.ok) return ok(result.data !== undefined ? JSON.stringify(result.data) : "ok (code.run)");
  return err(`code.run не удалось: ${result.error?.code ?? "runtime"} ${result.error?.message ?? ""}`);
}

async function memoryWrite(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const text = String(input.text ?? "").trim();
  if (!text) return err("memory_write: пустой text");
  const kind = (["preference", "fact", "event"] as const).includes(input.kind as never)
    ? (input.kind as "preference" | "fact" | "event")
    : "fact";
  await ctx.episodic.write({ userId: ctx.userId, kind, text, ts: Date.now() });
  return ok("Запомнил.");
}

const ok = (content: string): ToolResult => ({ content, isError: false });
const err = (content: string): ToolResult => ({ content, isError: true });
