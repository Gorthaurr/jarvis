/**
 * telegram_send, настоящий FakeDesktop: КАЖДЫЙ исход §14 (да / нет / истекло / не доставлено) — отдельный кейс с разными
 * словами; «ушло» доказывается эффектом на «ПК», а не текстом.
 */
import type { ToolCase } from "../case-format.js";
import { CLAIMS_SENT, KATYA, tgSeed } from "./comm-fixtures.js";

const ONE = tgSeed([KATYA]);
const SEND = { to: "Катя", text: "иду, буду через пять минут" };

export const cases: ToolCase[] = [
  {
    tool: "telegram_send",
    name: "«да» — сообщение легло в чат Кати Ивановой (эффект на «ПК»), sent:true",
    args: SEND,
    seed: ONE,
    confirm: "yes",
    expect: {
      ok: true,
      flags: { sent: true, declined: false, uncertain: false },
      asked: 1,
      actionKinds: ["telegram.send"],
      effects: [{ has: "telegram.send", count: 1, detail: { chatTitle: "Катя Иванова", peerId: "7", text: SEND.text, confirmed: true } }],
      resultIncludes: "Отправлено «Катя Иванова» в Telegram",
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "владелец сказал «нет» — не ушло: declined, клиенту ничего, «Отправлено» нет",
    args: SEND,
    seed: ONE,
    confirm: "no",
    expect: {
      ok: true,
      flags: { sent: false, declined: true, channelDown: false },
      asked: 1,
      actionKinds: [],
      effects: [{ none: "telegram.send" }],
      resultIncludes: /вы не подтвердили отправку/,
      resultExcludes: [CLAIMS_SENT, /истекло|не смог спросить/],
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "окно подтверждения истекло — отдельный исход: «не ответили», а не «отказали»",
    args: SEND,
    seed: ONE,
    confirm: "expire",
    expect: {
      flags: { sent: false, declined: true },
      asked: 1,
      actionKinds: [],
      resultIncludes: /вы не ответили на подтверждение, и оно истекло/,
      resultExcludes: [CLAIMS_SENT, /вы не подтвердили/],
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "владельца не смогли спросить — «не смог спросить» + channelDown, отказ ему не приписан",
    args: SEND,
    seed: ONE,
    confirm: "undelivered",
    expect: {
      flags: { sent: false, declined: true, channelDown: true },
      asked: 1,
      actionKinds: [],
      resultIncludes: /не смог спросить вашего подтверждения/,
      resultExcludes: [CLAIMS_SENT, /вы не подтвердили|вы не ответили/],
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "пустой текст — до владельца и клиента не доходит",
    args: { to: "Катя", text: "   " },
    seed: ONE,
    confirm: "yes",
    expect: { ok: false, asked: 0, actionKinds: [], flags: { sent: false }, resultIncludes: "нужны to и text" },
    coversTool: "telegram_send",
  },
];
