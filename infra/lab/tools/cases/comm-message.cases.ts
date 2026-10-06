/**
 * message_send (userbot vk/telegram): ТРИ исхода отправки и ВСЕ исходы §14. «Ушло» доказывает эффект message.send на «ПК»
 * (или его отсутствие), не текст. Инструмент модели не предлагается (EXCLUDED), но диспетчер его исполняет — гарды живые.
 * Успешная отправка занимает ~1–2 с: «человеческий конверт» (jitter) реальный, как в бою.
 */
import type { ToolCase } from "../case-format.js";
import { CLAIMS_SENT, compose, priorSend } from "./comm-fixtures.js";
import { faultyClient, sentKinds, wireEffects } from "./comm-wire.js";

const MSG = { channel: "vk", to: "id123", body: "привет, буду в семь" };
const lost = faultyClient(undefined, [{ kind: "message.send", mode: "lose-reply" }]);
const noSession = faultyClient(undefined, [{ kind: "message.send", mode: "drop", message: "канал vk не подключён — отправить не могу" }]);
const down = faultyClient(undefined, [{ kind: "message.send", mode: "drop", code: "channel_down", message: "канал недоступен" }]);
const dup = faultyClient(undefined);

export const cases: ToolCase[] = [
  {
    tool: "message_send",
    name: "«да» — сообщение реально ушло клиенту (эффект message.send), sent:true",
    args: MSG,
    confirm: "yes",
    expect: {
      ok: true,
      flags: { sent: true, declined: false, uncertain: false },
      asked: 1,
      actionKinds: ["message.send"],
      effects: [{ has: "message.send", count: 1, detail: { channel: "vk", to: "id123", body: MSG.body } }],
      resultIncludes: "Отправлено id123.",
    },
    coversTool: "message_send",
  },
  {
    tool: "message_send",
    name: "владелец «нет» — не ушло: declined, клиенту ничего",
    args: MSG,
    confirm: "no",
    expect: { flags: { sent: false, declined: true, channelDown: false }, asked: 1, actionKinds: [], effects: [{ none: "message.send" }], resultIncludes: /вы не подтвердили отправку сообщение «id123»/, resultExcludes: CLAIMS_SENT },
    coversTool: "message_send",
  },
  {
    tool: "message_send",
    name: "окно подтверждения истекло — «не ответили», а не «отказали»",
    args: MSG,
    confirm: "expire",
    expect: { flags: { sent: false, declined: true }, asked: 1, actionKinds: [], resultIncludes: /вы не ответили на подтверждение, и оно истекло/, resultExcludes: [CLAIMS_SENT, /вы не подтвердили/] },
    coversTool: "message_send",
  },
  {
    tool: "message_send",
    name: "владельца не смогли спросить — «не смог спросить» + channelDown, отказ ему не приписан",
    args: MSG,
    confirm: "undelivered",
    expect: { flags: { sent: false, declined: true, channelDown: true }, asked: 1, actionKinds: [], resultIncludes: /не смог спросить вашего подтверждения/, resultExcludes: [CLAIMS_SENT, /вы не подтвердили|вы не ответили/] },
    coversTool: "message_send",
  },
  {
    tool: "message_send",
    name: "неизвестный канал — ошибка до вопроса и до клиента",
    args: { ...MSG, channel: "sms" },
    confirm: "yes",
    expect: { ok: false, asked: 0, actionKinds: [], flags: { sent: false }, resultIncludes: "неизвестный channel" },
    coversTool: "message_send",
  },
  {
    tool: "message_send",
    name: "пустой получатель — ошибка до вопроса и до клиента",
    args: { ...MSG, to: "  " },
    confirm: "yes",
    expect: { ok: false, asked: 0, actionKinds: [], flags: { sent: false }, resultIncludes: "нужны to и body" },
    coversTool: "message_send",
  },
  {
    tool: "message_send",
    name: "клиент отказал (нет сессии канала) — «Не отправлено (error)», sent:false, uncertain:false",
    args: MSG,
    lab: { ctx: noSession.ctx },
    confirm: "yes",
    expect: { ok: false, flags: { sent: false, uncertain: false }, effects: [sentKinds(noSession, ["message.send"]), wireEffects(noSession, "message.send", 0)], resultIncludes: /Не отправлено \(error\): канал vk не подключён/, resultExcludes: CLAIMS_SENT },
    coversTool: "message_send",
  },
  {
    tool: "message_send",
    name: "клиент отправил, а ответ потерян — третий исход: uncertain, «Не знаю, ушло ли», не «не отправлено»",
    args: MSG,
    lab: { ctx: lost.ctx },
    confirm: "yes",
    expect: {
      ok: false,
      flags: { uncertain: true, sent: false },
      effects: [wireEffects(lost, "message.send", 1, { to: "id123" })],
      resultIncludes: [/Не знаю, ушло ли сообщение «id123»/, /Вслепую НЕ повторяю/],
      resultExcludes: [CLAIMS_SENT, /Не отправлено \(/],
    },
    coversTool: "message_send",
  },
  {
    tool: "message_send",
    name: "канал ПК мёртв (channel_down) — channelDown для петли (ждать reconnect), не sent",
    args: MSG,
    lab: { ctx: down.ctx },
    confirm: "yes",
    expect: { ok: false, flags: { channelDown: true, sent: false, uncertain: false }, effects: [sentKinds(down, ["message.send"])], resultIncludes: /канал с ПК недоступен/, resultExcludes: CLAIMS_SENT },
    coversTool: "message_send",
  },
  {
    tool: "message_send",
    name: "то же сообщение только что уходило (ресенд-окно) — повтор НЕ ушёл, владельца не дёргаем",
    args: MSG,
    lab: { ctx: compose(dup.ctx, priorSend({ channel: "vk", to: "id123", text: MSG.body })) },
    confirm: "yes",
    expect: { ok: true, flags: { sent: false, declined: false }, asked: 0, effects: [sentKinds(dup, [])], resultIncludes: [/Уже отправлял «id123»/, /повтор НЕ ушёл/, "resend:true"], resultExcludes: CLAIMS_SENT },
    coversTool: "message_send",
  },
  {
    tool: "message_send",
    name: "resend:true, владелец «да» — повтор уходит после ОДНОГО вопроса, а не двух",
    args: { ...MSG, resend: true },
    lab: { ctx: compose(dup.ctx, priorSend({ channel: "vk", to: "id123", text: MSG.body })) },
    confirm: "yes",
    expect: { ok: true, flags: { sent: true }, asked: 1, effects: [sentKinds(dup, ["message.send"]), wireEffects(dup, "message.send", 1, { body: MSG.body })], resultIncludes: "Отправлено id123." },
    coversTool: "message_send",
  },
  {
    tool: "message_send",
    name: "resend:true, владелец «нет» — повтора нет, отказ назван повторным",
    args: { ...MSG, resend: true },
    lab: { ctx: compose(dup.ctx, priorSend({ channel: "vk", to: "id123", text: MSG.body })) },
    confirm: "no",
    expect: { flags: { declined: true, sent: false }, asked: 1, effects: [sentKinds(dup, [])], resultIncludes: /повторную отправку сообщение «id123»/, resultExcludes: CLAIMS_SENT },
    coversTool: "message_send",
  },
  {
    tool: "message_send",
    name: "почти такой же текст тому же человеку (вдогонку) — без resend, но только через вопрос владельцу",
    args: { channel: "vk", to: "id123", body: "люблю тебя ❤" },
    lab: { ctx: compose(dup.ctx, priorSend({ channel: "vk", to: "id123", text: "я люблю тебя" })) },
    confirm: "no",
    expect: { flags: { declined: true, sent: false }, asked: 1, effects: [sentKinds(dup, [])], resultExcludes: CLAIMS_SENT },
    coversTool: "message_send",
  },
];
