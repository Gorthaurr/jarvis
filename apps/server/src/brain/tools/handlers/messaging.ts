/**
 * Хендлеры ИСХОДЯЩИХ сообщений/заказов (§14) — вынесено из god-object dispatch.ts (§ревью).
 * telegram_send (невидимый CDP + расширение-фолбэк), telegram_send_voice, message_send (vk/telegram через
 * outbound-гард), order_place (red-line карты §0). Общие send-гарды (confirm-once + cadence + идемпотентность)
 * живут здесь, рядом с потребителями. Маршрутизация остаётся в dispatch (switch).
 */
import { DEFAULT_ACTION_TIMEOUT_MS, type MessageChannel } from "@jarvis/protocol";
import { nameSearchVariants } from "@jarvis/shared";
import { approveSend, isSendApproved } from "../../consent.js";
import { CadenceGuard } from "../../messaging/cadence.js";
import { idempotencyKey, sendOutbound } from "../../messaging/outbound.js";
import { CardDataError, DEFAULT_ORDER_POLICY, type OrderItem } from "../../orders/order-guard.js";
import { placeOrder } from "../../orders/orders.js";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { channelDownResult, err, ok } from "../dispatch-util.js";

/**
 * Подтверждение отправки адресату ОДИН РАЗ (§14, фидбэк пользователя). Если этого адресата уже одобряли
 * когда-либо (в т.ч. в прошлой сессии — согласие персистентно) — не переспрашиваем. Иначе спрашиваем;
 * чистое одобрение запоминаем НАВСЕГДА (ревизия текста согласие не фиксирует).
 */
async function confirmSendOnce(
  ctx: ToolContext,
  channel: string,
  recipient: string,
  summary: string,
): Promise<{ approved: boolean; revision?: string }> {
  if (isSendApproved(ctx.userId, channel, recipient)) {
    return { approved: true };
  }
  if (!ctx.confirm) return { approved: false };
  const r = await ctx.confirm(summary, "send");
  if (r.approved) await approveSend(ctx.userId, channel, recipient);
  return r;
}

/** Cadence/идемпотентность переписки — на процесс (per-user внутри, §14). */
const cadence = new CadenceGuard();
const sentKeys = new Set<string>();
/** Идемпотентность заказов — на процесс (§14). */
const placedOrderKeys = new Set<string>();

/** Проблема резолва адресата (не транспорт): не нашёл/неоднозначно/не залогинен. */
function isResolveIssue(msg: string): boolean {
  return /\[tg-resolve\]|не залогинен/i.test(msg);
}
/** Убрать служебный маркер «[tg-resolve]» перед показом модели. */
function stripResolveMarker(msg: string): string {
  return msg.replace(/\[tg-resolve\]\s*/g, "").trim();
}
/** Достать имя чата из data результата (CDP/расширение возвращают chatTitle/matched). */
function chatTitleOf(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as { chatTitle?: unknown; matched?: unknown };
  const t = (typeof d.chatTitle === "string" && d.chatTitle) || (typeof d.matched === "string" && d.matched) || "";
  return String(t).trim();
}

/**
 * Невидимая отправка в Telegram (§6). ОСНОВНОЙ путь — клиентский выделенный Chrome + CDP (telegram.send):
 * окно за экраном, реальный webK, доставка подтверждается исходящим пузырём. Расширение — fallback при сбое CDP.
 */
export async function telegramSend(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const to = String(input.to ?? "").trim();
  const text = String(input.text ?? "").trim();
  if (!to || !text) return err("telegram_send: нужны to и text");
  // M6: cadence-гард — тот же механизм, что message_send (анти-бан/анти-веер/анти-burst).
  const cad = cadence.check({ userId: ctx.userId, channel: "telegram", recipient: to, neverMessagedBefore: false });
  if (!cad.allowed) return err(`Не отправил «${to}»: cadence-лимит (${cad.reason}).`);
  // M6: идемпотентность — тот же ключ/набор, что message_send. Ретрай агента после таймаута не дублирует отправку.
  const key = idempotencyKey({ userId: ctx.userId, channel: "telegram", recipient: to, body: text });
  if (sentKeys.has(key)) return ok(`Уже отправлено «${to}» в Telegram (повтор не ушёл).`);
  // §14: отправка — критичное действие, подтверждаем ОДИН раз на адресата (дальше помним навсегда).
  const gate = await confirmSendOnce(ctx, "telegram", to, `Отправить «${to}» в Telegram?\n${text.slice(0, 160)}${text.length > 160 ? "…" : ""}`);
  if (!gate.approved) return ok(`Не отправил — вы не подтвердили отправку «${to}».`);
  // ОПЫТНАЯ ПАМЯТЬ (§ скорость): помним, как резолвили этого адресата → клиент откроет чат СРАЗУ.
  const hint = ctx.resolutionMemory?.recall(ctx.userId, "telegram", to);
  const result = await ctx.session.sendAction({ kind: "telegram.send", to, text, preferredTitle: hint?.title, hintPeerId: hint?.peerId }, 90_000);
  if (result.ok) {
    const data = result.data as { chatTitle?: string; peerId?: string } | undefined;
    const who = chatTitleOf(result.data) || to; // называем РЕАЛЬНОГО адресата (мог отличаться: Герман→Herman)
    if (data?.chatTitle) ctx.resolutionMemory?.remember(ctx.userId, "telegram", to, { peerId: data.peerId, title: data.chatTitle });
    sentKeys.add(key);
    cadence.record(ctx.userId, "telegram", to);
    return ok(`Отправлено «${who}» в Telegram.`);
  }
  // Б4 (интеграционное ревью #4): канал ПК мёртв (resume-grace) — команда не ушла. Основной CDP-путь
  // недоступен; фолбэк на расширение идёт через ОТДЕЛЬНЫЙ /ext-сокет (может быть жив), поэтому пробуем
  // его; но если фолбэка нет/тоже не вышел — помечаем channelDown (петля ждёт reconnect, не эскалирует).
  const wasChannelDown = !result.ok && result.error?.code === "channel_down";
  const rawReason = result.error?.message ?? "ошибка";
  const reason = stripResolveMarker(rawReason);
  // self-heal: вели по памяти, но резолв не вышел → запомненное устарело → забываем.
  if (hint && isResolveIssue(rawReason)) ctx.resolutionMemory?.forget(ctx.userId, "telegram", to);
  // Проблема РЕЗОЛВА (не нашёл/неоднозначно/не залогинен) — НЕ транспортный сбой: отдаём модели без фолбэка.
  if (isResolveIssue(rawReason)) return err(reason);
  // Иначе — транспортный сбой CDP-пути: пробуем расширение (те же транслит-варианты для recall).
  if (ctx.telegramSend) {
    try {
      const out = await ctx.telegramSend(to, text, nameSearchVariants(to));
      const who = chatTitleOf(out) || to;
      sentKeys.add(key);
      cadence.record(ctx.userId, "telegram", to);
      return ok(`Отправлено «${who}» в Telegram (через расширение).`);
    } catch (e) {
      const em = stripResolveMarker(e instanceof Error ? e.message : String(e));
      // Фолбэк тоже не вышел, а исходно был channel_down → петля пусть ждёт reconnect (не эскалирует).
      if (wasChannelDown) {
        const cd = channelDownResult(result, "telegram_send не отправлен: канал с ПК недоступен (переподключение).");
        if (cd) return cd;
      }
      return err(`Не удалось отправить в Telegram: ${reason}; расширение: ${em}`);
    }
  }
  // Фолбэка нет и канал ПК мёртв → channelDown (не эскалируем тир на транспортном сбое).
  const cd = channelDownResult(result, "telegram_send не отправлен: канал с ПК недоступен (переподключение).");
  if (cd) return cd;
  return err(`Не удалось отправить в Telegram: ${reason}`);
}

/**
 * §: ГОЛОСОВОЕ в Telegram голосом филиппа. Синтез TTS (synthVoice) → mp3 base64 → расширение записывает
 * его в web.telegram как голосовое (подмена микрофона). Гейт §14 — как у telegram_send (confirm на адресата).
 */
export async function telegramSendVoiceHandler(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const to = String(input.to ?? "").trim();
  const text = String(input.text ?? "").trim();
  if (!to || !text) return err("telegram_send_voice: нужны to и text (что произнести голосом)");
  if (!ctx.synthVoice || !ctx.telegramSendVoice) return err("Голосовые недоступны: нет TTS или расширение не подключено.");
  const gate = await confirmSendOnce(ctx, "telegram", to, `Отправить ГОЛОСОВОЕ «${to}» (голос филиппа)?\n«${text.slice(0, 160)}${text.length > 160 ? "…" : ""}»`);
  if (!gate.approved) return ok(`Не отправил голосовое — вы не подтвердили «${to}».`);
  try {
    const audioB64 = await ctx.synthVoice(text); // mp3 base64 голосом филиппа
    await ctx.telegramSendVoice(to, audioB64);
    return ok(`Отправил голосовое «${to}» голосом филиппа.`);
  } catch (e) {
    return err(`Не вышло отправить голосовое «${to}»: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** message.send под гардами §14: confirm (revise-петля) + cadence + idempotency (UC-2). */
export async function messageSend(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.confirm) return err("отправка недоступна: нет канала подтверждения (§14)");
  const channel = input.channel as MessageChannel;
  const to = String(input.to ?? "").trim();
  const body = String(input.body ?? "").trim();
  if (channel !== "vk" && channel !== "telegram") return err("message_send: неизвестный channel");
  if (!to || !body) return err("message_send: нужны to и body");

  let channelDown = false; // Б4 (интеграционное ревью #4): код channel_down теряется в обёртке — ловим сами
  const res = await sendOutbound(
    { userId: ctx.userId, channel, recipient: to, body, neverMessagedBefore: true },
    {
      // §14: подтверждаем адресата один раз, дальше помним навсегда (как telegram_send).
      requestConfirm: (summary) => confirmSendOnce(ctx, channel, to, summary),
      regenerate: async (_rev, prev) => prev, // полная перегенерация — через новый ход агента
      cadence,
      isAlreadySent: (k) => sentKeys.has(k),
      markSent: (k) => sentKeys.add(k),
      send: async (ch, rcpt, b) => {
        const r = await ctx.session.sendAction({ kind: "message.send", channel: ch, to: rcpt, body: b }, DEFAULT_ACTION_TIMEOUT_MS);
        if (r.error?.code === "channel_down") channelDown = true;
        return { ok: r.ok, error: r.error?.message };
      },
    },
  );
  if (res.status === "sent") return ok(`Отправлено ${to}.`);
  if (channelDown) {
    const cd = channelDownResult({ ok: false, error: { code: "channel_down" } }, "message_send не отправлен: канал с ПК недоступен (переподключение).");
    if (cd) return cd;
  }
  return err(`Не отправлено (${res.status}): ${res.reason ?? ""}`);
}

/** order.place под гардами §14 + красная линия карты §0 (UC-5). */
export async function orderPlace(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.confirm) return err("заказ недоступен: нет канала подтверждения (§14)");
  const vendor = String(input.vendor ?? "").trim();
  const items = (Array.isArray(input.items) ? input.items : []) as OrderItem[];
  const total = Number(input.total ?? 0);
  if (!vendor || items.length === 0) return err("order_place: нужны vendor и items");
  let channelDown = false; // Б4 (интеграционное ревью #4): channel_down теряется в обёртке — ловим сами
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
        if (r.error?.code === "channel_down") channelDown = true;
        return { ok: r.ok, error: r.error?.message, orderId: (r.data as { orderId?: string })?.orderId };
      },
    });
    if (res.status === "placed") return ok(`Заказ оформлен в «${vendor}» на ${total}.`);
    if (channelDown) {
      const cd = channelDownResult({ ok: false, error: { code: "channel_down" } }, "order_place не отправлен: канал с ПК недоступен (переподключение).");
      if (cd) return cd;
    }
    return err(`Заказ не оформлен (${res.status}): ${res.reason ?? ""}`);
  } catch (e) {
    if (e instanceof CardDataError) return err(e.message); // §0: красная линия карты
    throw e;
  }
}
