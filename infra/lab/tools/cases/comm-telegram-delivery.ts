import type { ToolCase } from "../case-format.js";
import { CLAIMS_SENT, KATYA, tgSeed } from "./comm-fixtures.js";
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
];
