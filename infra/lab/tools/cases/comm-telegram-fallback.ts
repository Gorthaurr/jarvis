import type { ToolCase } from "../case-format.js";
import { CLAIMS_SENT, KATYA, tgSeed } from "./comm-fixtures.js";
import { exactly, faultyClient, sentKinds, wireEffects } from "./comm-wire.js";

const SEED = tgSeed([KATYA]);

const SEND = { to: "Катя", text: "иду, буду через пять минут" };

const DROP = { kind: "telegram.send", mode: "drop", message: "CDP: вкладка Telegram не отвечает" } as const;

const viaExt = faultyClient(SEED, [DROP], { telegramSend: "ok" });

const extDead = faultyClient(SEED, [DROP], { telegramSend: "fail" });

const veiled = faultyClient(SEED, [DROP], { telegramSend: "ok", veil: true });

export const cases: ToolCase[] = [
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
];
