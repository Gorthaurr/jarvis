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
import { CardDataError, DEFAULT_ORDER_POLICY, type OrderItem } from "../orders/order-guard.js";
import { placeOrder } from "../orders/orders.js";
import type { DynamicToolParam, DynamicToolStore } from "./dynamic.js";
import type { SkillProvider } from "../../memory/skills.js";

/** Минимальный приёмник действий (реализует Session). */
export interface ActuatorSink {
  sendAction(cmd: ActionCommand, timeoutMs?: number): Promise<ActionResult>;
}

export interface ToolContext {
  session: ActuatorSink;
  web: IWebProvider;
  episodic: EpisodicMemory;
  userId: string;
  /** Подтверждение необратимого (§14). kind задаёт вид модалки: send|order|irreversible. */
  confirm?: (
    summary: string,
    kind?: "send" | "order" | "irreversible",
  ) => Promise<{ approved: boolean; revision?: string }>;
  /** Реестр самописных инструментов (§8+ саморасширение). */
  dynamicTools?: DynamicToolStore;
  /** Провайдер выученных показом навыков (§8): каталог + резолв для skill_execute. */
  skills?: SkillProvider;
  /** Отправка в Telegram через браузерное расширение (§6): невидимо, фоновой вкладкой. */
  telegramSend?: (to: string, text: string) => Promise<unknown>;
}

/** Cadence/идемпотентность переписки — на процесс (per-user внутри, §14). */
const cadence = new CadenceGuard();
const sentKeys = new Set<string>();
/** Идемпотентность заказов — на процесс (§14). */
const placedOrderKeys = new Set<string>();

export interface ToolResult {
  content: string;
  isError: boolean;
}

/** tool name → ActionKind (реверс ACTUATOR_TOOL_BY_KIND). */
const KIND_BY_TOOL: Record<string, ActionKind> = Object.fromEntries(
  (Object.entries(ACTUATOR_TOOL_BY_KIND) as [ActionKind, string][]).map(([kind, tool]) => [tool, kind]),
) as Record<string, ActionKind>;

/** Инструменты, отложенные на будущее (сейчас пусто: message_send/order_place подключены). */
const DEFERRED_TOOLS = new Set<string>();

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
    case "telegram_send":
      return telegramSend(ctx, input);
    case "message_send":
      return messageSend(ctx, input);
    // Саморасширение (§8+): Джарвис создаёт/смотрит/удаляет собственные инструменты.
    case "tool_create":
      return toolCreate(ctx, input);
    case "tool_list":
      return toolList(ctx);
    case "tool_remove":
      return toolRemove(ctx, input);
    // Навыки, выученные показом (§8): каталог + запуск по id (сервер резолвит шаги).
    case "skill_list":
      return skillList(ctx);
    case "skill_execute":
      return skillExecute(ctx, input);
  }

  if (DEFERRED_TOOLS.has(name)) {
    return err(`Инструмент ${name} пока недоступен.`);
  }

  // Вызов самописного инструмента по имени (§8+): рендерим шаблон → гард­ированный code.run.
  // ВАЖНО: только если имя НЕ принадлежит встроенному актуатору — самописный инструмент
  // не должен затенять штатный (особенно confirm-гейтнутые fs_delete/system_power).
  if (!KIND_BY_TOOL[name] && ctx.dynamicTools?.has(name)) {
    return runDynamicTool(ctx, name, input);
  }

  // code.run — серверный lint-гард ДО отправки клиенту (§6, §14).
  if (name === "code_run") return runCodeGuarded(ctx, input);
  // order.place — гарды §14 (spend cap/allowlist/confirm/idempotency) + красная линия карты (§0).
  if (name === "order_place") return orderPlace(ctx, input);

  // Необратимые fs/system действия — confirm ДО исполнения (§4): удаление файлов и
  // выключение/перезагрузка/выход. Блокировка, сон, чтение, запись/правка — без confirm
  // (пользователь хочет избыточного, но без потери данных «вслепую»).
  if (name === "fs_delete" || (name === "system_power" && input.op !== "sleep")) {
    if (!ctx.confirm) return err(`${name}: требуется подтверждение, но канал недоступен (§4)`);
    const summary =
      name === "fs_delete"
        ? `Удалить «${String(input.path ?? "")}»? Действие необратимо.`
        : `Питание: ${String(input.op ?? "")}. Несохранённая работа будет потеряна. Подтвердите?`;
    const { approved } = await ctx.confirm(summary, "irreversible");
    if (!approved) return ok(`Отменено пользователем (${name}).`);
  }

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
  // Схема инструмента (§12) объявляет поле `count`; принимаем и `limit` для совместимости.
  const limit = numField(input, ["count", "limit"], 5);
  const hits = await ctx.web.search(q, limit);
  if (hits.length === 0) return ok("Ничего не найдено (или web-провайдер в стаб-режиме).");
  return ok(hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n"));
}

async function webFetch(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const url = String(input.url ?? "").trim();
  if (!url) return err("web_fetch: пустой url");
  const page = await ctx.web.fetch(url);
  if (!page) return err("Не удалось загрузить страницу.");
  // Схема инструмента (§12) объявляет maxChars — honor'им, если задан.
  const max = numField(input, ["maxChars"], 0);
  const text = max > 0 ? page.text.slice(0, max) : page.text;
  return ok(`# ${page.title}\n${text}`);
}

async function memorySearch(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const q = String(input.query ?? "").trim();
  if (!q) return err("memory_search: пустой query");
  // Схема инструмента (§8) объявляет `topK`; принимаем и `k` для совместимости.
  const k = numField(input, ["topK", "k"], 5);
  const hits = await ctx.episodic.search(ctx.userId, q, k);
  if (hits.length === 0) return ok("В памяти ничего релевантного не найдено.");
  return ok(hits.map((h) => `- ${h.episode.text} (${h.score.toFixed(2)})`).join("\n"));
}

/**
 * Невидимая отправка в Telegram (§6). ОСНОВНОЙ путь — клиентский выделенный Chrome + CDP
 * (ActionCommand telegram.send): окно за экраном, реальный webK, доставка подтверждается
 * исходящим пузырём. Браузерное расширение (ctx.telegramSend) — fallback при сбое CDP-пути.
 */
async function telegramSend(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const to = String(input.to ?? "").trim();
  const text = String(input.text ?? "").trim();
  if (!to || !text) return err("telegram_send: нужны to и text");
  // CDP-путь на клиенте (cold start webK ~6с + ходы → щедрый таймаут).
  const result = await ctx.session.sendAction({ kind: "telegram.send", to, text }, 90_000);
  if (result.ok) return ok(`Отправлено «${to}» в Telegram.`);
  const reason = result.error?.message ?? "ошибка";
  // Fallback на расширение (если подключено).
  if (ctx.telegramSend) {
    try {
      await ctx.telegramSend(to, text);
      return ok(`Отправлено «${to}» в Telegram (через расширение).`);
    } catch (e) {
      return err(`Не удалось отправить в Telegram: ${reason}; расширение тоже не смогло: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return err(`Не удалось отправить в Telegram: ${reason}`);
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

/** order.place под гардами §14 + красная линия карты §0 (UC-5). */
async function orderPlace(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.confirm) return err("заказ недоступен: нет канала подтверждения (§14)");
  const vendor = String(input.vendor ?? "").trim();
  const items = (Array.isArray(input.items) ? input.items : []) as OrderItem[];
  const total = Number(input.total ?? 0);
  if (!vendor || items.length === 0) return err("order_place: нужны vendor и items");
  try {
    const res = await placeOrder({ userId: ctx.userId, vendor, items, total }, DEFAULT_ORDER_POLICY, {
      requestConfirm: async (summary) => ({ approved: (await ctx.confirm!(summary, "order")).approved }),
      isAlreadyPlaced: (k) => placedOrderKeys.has(k),
      markPlaced: (k) => placedOrderKeys.add(k),
      place: async (req) => {
        const r = await ctx.session.sendAction(
          { kind: "order.place", vendor: req.vendor, items: req.items as unknown as Record<string, unknown>[], total: req.total },
          DEFAULT_ACTION_TIMEOUT_MS,
        );
        return { ok: r.ok, error: r.error?.message, orderId: (r.data as { orderId?: string })?.orderId };
      },
    });
    if (res.status === "placed") return ok(`Заказ оформлен в «${vendor}» на ${total}.`);
    return err(`Заказ не оформлен (${res.status}): ${res.reason ?? ""}`);
  } catch (e) {
    if (e instanceof CardDataError) return err(e.message); // §0: красная линия карты
    throw e;
  }
}

/** code.run под серверным lint-гардом (§6): запрет реестра/служб/сети/системных путей. */
async function runCodeGuarded(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const lang = input.lang as CodeLang;
  const code = String(input.code ?? "");
  if (!["python", "node", "powershell"].includes(lang)) return err("code_run: неизвестный lang");
  if (!code.trim()) return err("code_run: пустой код");
  return executeGuardedCode(ctx, lang, code);
}

/**
 * Единый гард­ированный путь исполнения кода (§6): lint → (powershell: confirm) → code.run.
 * Используется и code_run, и самописными инструментами — самописный не обходит предохранители.
 */
async function executeGuardedCode(ctx: ToolContext, lang: CodeLang, code: string): Promise<ToolResult> {
  const lint = lintCode(lang, code);
  if (!lint.ok) {
    return err(`код отклонён гардом (§6): ${lint.violations.map((v) => v.message).join("; ")}`);
  }
  if (lint.requiresConfirm) {
    // §6: powershell ВСЕГДА требует confirm + CLM. Если канал есть — спрашиваем (автономия §14).
    if (!ctx.confirm) return err("powershell требует подтверждения (§6), но канал недоступен.");
    const { approved } = await ctx.confirm(`Выполнить код?\n${code.slice(0, 160)}${code.length > 160 ? "…" : ""}`, "irreversible");
    if (!approved) return ok("Отменено пользователем (powershell).");
  }
  const result = await ctx.session.sendAction({ kind: "code.run", lang, code }, DEFAULT_ACTION_TIMEOUT_MS);
  if (result.ok) return ok(result.data !== undefined ? JSON.stringify(result.data) : "ok (code.run)");
  return err(`code.run не удалось: ${result.error?.code ?? "runtime"} ${result.error?.message ?? ""}`);
}

// ── Саморасширение (§8+): инструменты, которые Джарвис пишет себе сам ──

/** Создать/обновить самописный инструмент (валидируется именем/языком/гардом). */
async function toolCreate(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.dynamicTools) return err("саморасширение недоступно (нет реестра инструментов)");
  const res = await ctx.dynamicTools.create({
    name: String(input.name ?? ""),
    description: String(input.description ?? ""),
    lang: String(input.lang ?? ""),
    code: String(input.code ?? ""),
    params: Array.isArray(input.params) ? (input.params as DynamicToolParam[]) : [],
  });
  if (!res.ok) return err(`tool_create: ${res.error}`);
  return ok(`Инструмент «${input.name}» создан и готов к вызову (как обычный инструмент на след. ходах).`);
}

function toolList(ctx: ToolContext): ToolResult {
  const list = ctx.dynamicTools?.list() ?? [];
  if (list.length === 0) return ok("Самописных инструментов пока нет.");
  return ok(list.map((t) => `- ${t.name} (${t.lang}): ${t.description}`).join("\n"));
}

async function toolRemove(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.dynamicTools) return err("саморасширение недоступно");
  const removed = await ctx.dynamicTools.remove(String(input.name ?? ""));
  return removed ? ok(`Инструмент «${input.name}» удалён.`) : err(`Инструмент «${input.name}» не найден.`);
}

/** Исполнить самописный инструмент: подставить аргументы в шаблон → гард­ированный code.run. */
async function runDynamicTool(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const r = ctx.dynamicTools!.render(name, input);
  if (!r.ok || !r.lang || r.code === undefined) return err(r.error ?? "не удалось подготовить инструмент");
  return executeGuardedCode(ctx, r.lang, r.code);
}

// ── Навыки, выученные показом (§8): каталог + запуск по id ──

/** Каталог выученных навыков для модели (id, имя, версия). */
async function skillList(ctx: ToolContext): Promise<ToolResult> {
  const list = (await ctx.skills?.list(ctx.userId)) ?? [];
  if (list.length === 0) return ok("Выученных навыков пока нет.");
  return ok(
    list
      .map((s) => `- ${s.id}: «${s.name}» v${s.version}${s.needsReview ? " (требует подтверждения)" : ""}`)
      .join("\n"),
  );
}

/** Запустить навык по id: сервер резолвит шаги/версию → эмитит skill.execute клиенту (§8). */
async function skillExecute(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.skills) return err("навыки недоступны (нет провайдера)");
  const skillId = String(input.skillId ?? "").trim();
  if (!skillId) return err("skill_execute: нужен skillId (из skill_list)");
  const skill = await ctx.skills.get(ctx.userId, skillId);
  if (!skill) return err(`навык «${skillId}» не найден`);
  // Навык с guard-шагами (отправка/заказ/код) — подтверждение перед запуском (§14).
  if (skill.needsReview) {
    if (!ctx.confirm) return err(`навык «${skillId}» содержит необратимые шаги — нужно подтверждение (§14), но канал недоступен`);
    const { approved } = await ctx.confirm(`Запустить навык «${skillId}»? Он содержит необратимые шаги.`, "irreversible");
    if (!approved) return ok(`Отменено пользователем (навык ${skillId}).`);
  }
  const params = input.params && typeof input.params === "object" ? (input.params as Record<string, unknown>) : undefined;
  const result = await ctx.session.sendAction(
    { kind: "skill.execute", skillId: skill.id, version: skill.version, steps: skill.steps, params },
    DEFAULT_ACTION_TIMEOUT_MS,
  );
  if (result.ok) return ok(result.data !== undefined ? JSON.stringify(result.data) : `Навык «${skillId}» выполнен.`);
  return err(`Навык «${skillId}» не выполнен: ${result.error?.code ?? "runtime"} ${result.error?.message ?? ""}`);
}

async function memoryWrite(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  // Схема инструмента (§8) объявляет поле `content`; принимаем и `text` для совместимости.
  const text = String(input.content ?? input.text ?? "").trim();
  if (!text) return err("memory_write: пустой content");
  await ctx.episodic.write({ userId: ctx.userId, kind: normalizeEpisodeKind(input.kind), text, ts: Date.now() });
  return ok("Запомнил.");
}

/**
 * Привести kind из схемы инструмента (episodic|semantic) к типу эпизода хранилища
 * (preference|fact|event, §13). Принимаем и прямые значения хранилища.
 */
function normalizeEpisodeKind(raw: unknown): "preference" | "fact" | "event" {
  const k = String(raw ?? "");
  if (k === "preference" || k === "fact" || k === "event") return k;
  if (k === "semantic") return "fact"; // устойчивый факт
  return "event"; // episodic/по умолчанию — событие
}

/** Прочитать числовое поле по одному из синонимичных имён (схема ↔ диспетчер). */
function numField(input: Record<string, unknown>, names: string[], fallback: number): number {
  for (const n of names) {
    const v = input[n];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return fallback;
}

const ok = (content: string): ToolResult => ({ content, isError: false });
const err = (content: string): ToolResult => ({ content, isError: true });
