/**
 * telegram_send: ТРЕТИЙ исход отправки (закон 1). Клиент-обёртка (comm-wire.ts) теряет ответ или не доносит команду, а
 * «ПК» честно показывает, ушло ли на самом деле: сообщение в чате есть/нет. Инструмент обязан сказать то, что было,
 * и НИКОГДА не слать второй раз вслепую (эпизод «Катя получила дубль», 2026-08-31).
 */
import type { ToolCase } from "../case-format.js";
import { CLAIMS_SENT, KATYA, priorSend, tgSeed, compose } from "./comm-fixtures.js";
import { exactly, faultyClient, sentKinds, wireEffects } from "./comm-wire.js";

const SEED = tgSeed([KATYA]);
const SEND = { to: "Катя", text: "иду, буду через пять минут" };
const LOST = { kind: "telegram.send", mode: "lose-reply" } as const;
const DROP = { kind: "telegram.send", mode: "drop", message: "CDP: вкладка Telegram не отвечает" } as const;
const NO_READ = { kind: "telegram.read", mode: "drop", message: "чат не читается" } as const;

const delivered = faultyClient(SEED, [LOST], { telegramSend: "ok" });
const absent = faultyClient(SEED, [DROP]);
const unknown = faultyClient(SEED, [{ ...DROP, code: "timeout" }, NO_READ]);
const lostUnread = faultyClient(SEED, [LOST, NO_READ], { telegramSend: "ok" });
const down = faultyClient(SEED, [{ ...DROP, code: "channel_down", message: "канал недоступен" }]);
const viaExt = faultyClient(SEED, [DROP], { telegramSend: "ok" });
const extDead = faultyClient(SEED, [DROP], { telegramSend: "fail" });
const veiled = faultyClient(SEED, [DROP], { telegramSend: "ok", veil: true });
const guarded = faultyClient(SEED);

export const cases: ToolCase[] = [
  {
    tool: "telegram_send",
    name: "клиент отправил, ответ потерян: сверка чтением чата видит сообщение — sent:true, расширение-дубль НЕ вызвано",
    args: SEND,
    lab: { ctx: delivered.ctx },
    confirm: "yes",
    expect: {
      ok: true,
      flags: { sent: true, uncertain: false },
      asked: 1,
      effects: [sentKinds(delivered, ["telegram.send", "telegram.read"]), wireEffects(delivered, "telegram.send", 1, { text: SEND.text }), exactly("фолбэк-расширение", delivered.extSends, 0)],
      resultIncludes: /повторять НЕ нужно/,
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "не дошло до клиента и в чате сообщения нет: честное «не удалось», sent:false, uncertain:false",
    args: SEND,
    lab: { ctx: absent.ctx },
    confirm: "yes",
    expect: {
      ok: false,
      flags: { sent: false, uncertain: false },
      effects: [sentKinds(absent, ["telegram.send", "telegram.read"]), wireEffects(absent, "telegram.send", 0)],
      resultIncludes: "Не удалось отправить в Telegram: CDP: вкладка Telegram не отвечает",
      resultExcludes: CLAIMS_SENT,
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "обрыв и чат не прочитать — uncertain:true, «Не знаю, ушло ли», повтор вслепую не делается",
    args: SEND,
    lab: { ctx: unknown.ctx },
    confirm: "yes",
    expect: {
      ok: false,
      flags: { uncertain: true, sent: false },
      effects: [sentKinds(unknown, ["telegram.send", "telegram.read"]), wireEffects(unknown, "telegram.send", 0)],
      resultIncludes: [/Не знаю, ушло ли сообщение «Катя»/, /Вслепую НЕ повторяю/, "resend:true"],
      resultExcludes: CLAIMS_SENT,
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "сообщение РЕАЛЬНО ушло, но ответ потерян и чат не прочитать: честное uncertain, а не «ушло» и не дубль через расширение",
    args: SEND,
    lab: { ctx: lostUnread.ctx },
    confirm: "yes",
    expect: {
      ok: false,
      flags: { uncertain: true, sent: false },
      effects: [wireEffects(lostUnread, "telegram.send", 1), exactly("фолбэк-расширение", lostUnread.extSends, 0)],
      resultIncludes: /Не знаю, ушло ли/,
      resultExcludes: CLAIMS_SENT,
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "канал ПК мёртв (channel_down): сверять нечем и нечем читать — channelDown, не uncertain, чтение чата не зовётся",
    args: SEND,
    lab: { ctx: down.ctx },
    confirm: "yes",
    expect: {
      ok: false,
      flags: { channelDown: true, sent: false, uncertain: false },
      effects: [sentKinds(down, ["telegram.send"])],
      resultIncludes: /канал с ПК недоступен/,
      resultExcludes: CLAIMS_SENT,
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "CDP доказанно не отправил (чат без сообщения) — фолбэк через расширение уходит РОВНО один раз, sent:true",
    args: SEND,
    lab: { ctx: viaExt.ctx },
    confirm: "yes",
    expect: {
      ok: true,
      flags: { sent: true },
      effects: [sentKinds(viaExt, ["telegram.send", "telegram.read"]), exactly("фолбэк-расширение", viaExt.extSends, 1)],
      resultIncludes: "Отправлено «Катя» в Telegram (через расширение)",
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "и CDP, и расширение не смогли (чата с сообщением нет) — ошибка с обеими причинами, sent:false",
    args: SEND,
    lab: { ctx: extDead.ctx },
    confirm: "yes",
    expect: {
      ok: false,
      flags: { sent: false, uncertain: false },
      effects: [exactly("попыток расширения", extDead.extSends, 1), wireEffects(extDead, "telegram.send", 0)],
      resultIncludes: ["CDP: вкладка Telegram не отвечает", "расширение: вкладка Telegram не открыта"],
      resultExcludes: CLAIMS_SENT,
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "поверх экрана вуаль выделения — фолбэк через расширение НЕ вызван (отобрал бы клавиатуру у рамки), overlayDenied",
    args: SEND,
    lab: { ctx: veiled.ctx },
    confirm: "yes",
    expect: {
      ok: false,
      flags: { overlayDenied: true, sent: false },
      effects: [exactly("фолбэк-расширение", veiled.extSends, 0)],
      resultIncludes: /вуаль/,
      resultExcludes: CLAIMS_SENT,
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "прошлая отправка оборвалась (uncertain) — тот же текст без resend не уходит, вопроса нет, клиента нет",
    args: SEND,
    lab: { ctx: compose(guarded.ctx, priorSend({ channel: "telegram", to: "Катя", text: SEND.text, uncertain: true })) },
    confirm: "yes",
    expect: {
      ok: true,
      flags: { sent: false, declined: false },
      asked: 0,
      effects: [sentKinds(guarded, [])],
      resultIncludes: [/Не знаю, ушло ли это сообщение «Катя»/, "telegram_read"],
      resultExcludes: [CLAIMS_SENT, /Уже отправлял/],
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "resend после uncertain, владелец «нет» — повторной отправки нет, отказ назван повторным",
    args: { ...SEND, resend: true },
    lab: { ctx: compose(guarded.ctx, priorSend({ channel: "telegram", to: "Катя", text: SEND.text, uncertain: true })) },
    confirm: "no",
    expect: {
      flags: { declined: true, sent: false },
      asked: 1,
      effects: [sentKinds(guarded, [])],
      resultIncludes: /повторную отправку/,
      resultExcludes: CLAIMS_SENT,
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "resend после uncertain, владелец «да» — второй раз уходит ровно один раз (один вопрос, не два)",
    args: { ...SEND, resend: true },
    lab: { ctx: compose(guarded.ctx, priorSend({ channel: "telegram", to: "Катя", text: SEND.text, uncertain: true })) },
    confirm: "yes",
    expect: {
      ok: true,
      flags: { sent: true },
      asked: 1,
      effects: [sentKinds(guarded, ["telegram.send"]), wireEffects(guarded, "telegram.send", 1, { text: SEND.text })],
      resultIncludes: "Отправлено «Катя Иванова»",
    },
    coversTool: "telegram_send",
  },
];
