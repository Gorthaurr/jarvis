import type { ToolCase } from "../case-format.js";
import { CLAIMS_SENT, compose, KATYA, priorSend, tgSeed } from "./comm-fixtures.js";
import { faultyClient, sentKinds, wireEffects } from "./comm-wire.js";

const SEED = tgSeed([KATYA]);

const SEND = { to: "Катя", text: "иду, буду через пять минут" };

const guarded = faultyClient(SEED);

export const cases: ToolCase[] = [
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
