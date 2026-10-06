/**
 * telegram_send_voice: TTS и расширение Telegram — моки с журналом (ctx.synthVoice / ctx.telegramSendVoice), проверяется
 * ПОВЕДЕНИЕ сервера вокруг них: §14 на КАЖДЫЙ исход, три исхода отправки, гарды cadence/ресенд у голосового так же,
 * как у текста (эпизод 2026-07-24: голосовые шли мимо них). Без моков лаборатория инструмент не вызывает.
 */
import type { ToolCase } from "../case-format.js";
import { CLAIMS_SENT, compose, priorSend } from "./comm-fixtures.js";
import { exactly, faultyClient } from "./comm-wire.js";

const SAY = { to: "Катя", text: "буду через пять минут" };
const ok = faultyClient(undefined, [], { voice: "ok" });
const denied = faultyClient(undefined, [], { voice: "ok" });
const expired = faultyClient(undefined, [], { voice: "ok" });
const undelivered = faultyClient(undefined, [], { voice: "ok" });
const dead = faultyClient(undefined, [], { voice: "fail" });
const noReply = faultyClient(undefined, [], { voice: "no-reply" });
const fast = faultyClient(undefined, [], { voice: "ok" });
const dup = faultyClient(undefined, [], { voice: "ok" });

export const cases: ToolCase[] = [
  {
    tool: "telegram_send_voice",
    name: "«да» — голосовое ушло ровно один раз, sent:true",
    args: SAY,
    lab: { ctx: ok.ctx },
    confirm: "yes",
    expect: { ok: true, flags: { sent: true, uncertain: false, declined: false }, asked: 1, effects: [exactly("голосовых", ok.voiceSends, 1)], resultIncludes: "Отправил голосовое «Катя»" },
    coversTool: "telegram_send_voice",
  },
  {
    tool: "telegram_send_voice",
    name: "владелец «нет» — голосовое не ушло и не синтезировано в расширение",
    args: SAY,
    lab: { ctx: denied.ctx },
    confirm: "no",
    expect: { flags: { sent: false, declined: true, channelDown: false }, asked: 1, effects: [exactly("голосовых", denied.voiceSends, 0)], resultIncludes: /вы не подтвердили отправку голосовое/, resultExcludes: CLAIMS_SENT },
    coversTool: "telegram_send_voice",
  },
  {
    tool: "telegram_send_voice",
    name: "окно подтверждения истекло — «не ответили», голосовое не ушло",
    args: SAY,
    lab: { ctx: expired.ctx },
    confirm: "expire",
    expect: { flags: { sent: false, declined: true }, asked: 1, effects: [exactly("голосовых", expired.voiceSends, 0)], resultIncludes: /вы не ответили на подтверждение/, resultExcludes: [CLAIMS_SENT, /вы не подтвердили/] },
    coversTool: "telegram_send_voice",
  },
  {
    tool: "telegram_send_voice",
    name: "владельца не смогли спросить — «не смог спросить» + channelDown, голосовое не ушло",
    args: SAY,
    lab: { ctx: undelivered.ctx },
    confirm: "undelivered",
    expect: { flags: { sent: false, declined: true, channelDown: true }, asked: 1, effects: [exactly("голосовых", undelivered.voiceSends, 0)], resultIncludes: /не смог спросить/, resultExcludes: CLAIMS_SENT },
    coversTool: "telegram_send_voice",
  },
  {
    tool: "telegram_send_voice",
    name: "расширение упало до отправки — честная ошибка «не вышло», не uncertain, не sent",
    args: SAY,
    lab: { ctx: dead.ctx },
    confirm: "yes",
    expect: { ok: false, flags: { sent: false, uncertain: false }, effects: [exactly("попыток", dead.voiceSends, 1)], resultIncludes: "Не вышло отправить голосовое «Катя»: расширение: Telegram не открыт", resultExcludes: CLAIMS_SENT },
    coversTool: "telegram_send_voice",
  },
  {
    tool: "telegram_send_voice",
    name: "запрос ушёл, ответа расширения нет — третий исход: uncertain, «Не знаю, ушло ли», не «не вышло»",
    args: SAY,
    lab: { ctx: noReply.ctx },
    confirm: "yes",
    expect: { ok: false, flags: { uncertain: true, sent: false }, effects: [exactly("попыток", noReply.voiceSends, 1)], resultIncludes: [/Не знаю, ушло ли голосовое «Катя»/, /Вслепую НЕ повторяю/], resultExcludes: [CLAIMS_SENT, /Не вышло отправить/] },
    coversTool: "telegram_send_voice",
  },
  {
    tool: "telegram_send_voice",
    name: "два голосовых подряд (<3 с) — второе режет cadence(burst), расширению уходит только первое",
    args: { to: "Катя", text: "и ещё одно, другое по смыслу" },
    before: [{ tool: "telegram_send_voice", args: SAY, confirm: "yes" }],
    lab: { ctx: fast.ctx },
    confirm: "yes",
    expect: { ok: false, flags: { sent: false }, asked: 0, effects: [exactly("голосовых", fast.voiceSends, 1)], resultIncludes: /cadence-лимит \(burst\)/, resultExcludes: CLAIMS_SENT },
    coversTool: "telegram_send_voice",
  },
  {
    tool: "telegram_send_voice",
    name: "тот же текст только что ушёл сообщением — голосовое = повтор, идёт через владельца; «нет» — не ушло",
    args: SAY,
    lab: { ctx: compose(dup.ctx, priorSend({ channel: "telegram", to: "Катя", text: SAY.text })) },
    confirm: "no",
    expect: { flags: { declined: true, sent: false }, asked: 1, effects: [exactly("голосовых", dup.voiceSends, 0)], resultIncludes: /повторную отправку голосовое/, resultExcludes: CLAIMS_SENT },
    coversTool: "telegram_send_voice",
  },
  {
    tool: "telegram_send_voice",
    name: "без TTS и расширения лаборатория инструмент не вызывает — честно «не проверяется»",
    args: SAY,
    expect: { ok: false, notVerifiable: /TTS/, asked: 0, actionKinds: [] },
    coversTool: "telegram_send_voice",
  },
];
