/**
 * consent_list / consent_revoke: «кому Джарвис может писать без переспроса» (§14 confirm-once). Согласие возникает ТОЛЬКО
 * от «да» владельца (отказ/истечение/недоставка его не создают), отзыв снимает ВСЕ написания одного человека и
 * действительно возвращает вопрос, чужие согласия не видны и не отзываются.
 */
import type { ToolCase } from "../case-format.js";
import { CLAIMS_SENT, KATYA, prior, tgSeed } from "./comm-fixtures.js";
import { PASS_TIME, PASS_TIME_STEP, faultyClient, sentKinds } from "./comm-wire.js";

const SEED = tgSeed([KATYA]);
const ASK = { to: "Катя", text: "иду, буду через пять минут" };
const NONE = /Действующих согласий на отправку нет/;
const again = faultyClient(SEED, [PASS_TIME]);

export const cases: ToolCase[] = [
  {
    tool: "consent_list",
    name: "владелец ничего не разрешал — «согласий нет, каждая отправка спросит»",
    expect: { ok: true, actionKinds: [], asked: 0, resultIncludes: /каждая отправка новому адресату спросит подтверждение/ },
    coversTool: "consent_list",
  },
  {
    tool: "consent_list",
    name: "«да» Кате (telegram) и Ивану (vk) — оба в списке с каналом и датой",
    before: [
      { tool: "telegram_send", args: ASK, confirm: "yes" },
      { tool: "message_send", args: { channel: "vk", to: "id123", body: "привет" }, confirm: "yes" },
    ],
    seed: SEED,
    expect: { ok: true, resultIncludes: [/- telegram: «катя» \(одобрено \d{2}\.\d{2}\.\d{4}\)/, /- vk: «id123» \(одобрено/] },
    coversTool: "consent_list",
  },
  {
    tool: "consent_list",
    name: "владелец сказал «нет» на отправку — согласие НЕ создано (отказ не запоминается как разрешение)",
    before: [{ tool: "telegram_send", args: ASK, confirm: "no" }],
    seed: SEED,
    expect: { ok: true, resultIncludes: NONE },
    coversTool: "consent_list",
  },
  {
    tool: "consent_list",
    name: "вопрос истёк или не дошёл — согласия тоже нет",
    before: [{ tool: "telegram_send", args: ASK, confirm: "expire" }, { tool: "telegram_send", args: ASK, confirm: "undelivered" }],
    seed: SEED,
    expect: { ok: true, resultIncludes: NONE },
    coversTool: "consent_list",
  },
  {
    tool: "consent_list",
    name: "чужие согласия не видны: у другого владельца «Оля», у этого только «Катя»",
    lab: { ctx: prior({ consents: [{ channel: "telegram", to: "Катя" }], foreign: [{ channel: "telegram", to: "Оля" }] }) },
    expect: { ok: true, resultIncludes: "«катя»", resultExcludes: /оля/i },
    coversTool: "consent_list",
  },
  {
    tool: "consent_revoke",
    name: "отзыв согласия: ответ называет снятого адресата и обещает новый вопрос",
    args: { channel: "telegram", recipient: "Катя" },
    lab: { ctx: prior({ consents: [{ channel: "telegram", to: "Катя" }] }) },
    expect: { ok: true, actionKinds: [], resultIncludes: ["Согласие отозвано (telegram): «катя»", "снова спросит вашего подтверждения"] },
    coversTool: "consent_revoke",
  },
  {
    tool: "consent_list",
    name: "после отзыва в списке пусто (отзыв реально снимает запись, а не только говорит об этом)",
    before: [{ tool: "consent_revoke", args: { channel: "telegram", recipient: "Катя" } }],
    lab: { ctx: prior({ consents: [{ channel: "telegram", to: "Катя" }] }) },
    expect: { ok: true, resultIncludes: NONE, resultExcludes: "«катя»" },
    coversTool: "consent_revoke",
  },
  {
    tool: "telegram_send",
    name: "после отзыва следующая отправка снова спрашивает владельца (вопрос задан, «нет» — не ушло)",
    args: { to: "Катя", text: "совсем другой текст, про ужин" },
    before: [{ tool: "telegram_send", args: ASK, confirm: "yes" }, { tool: "consent_revoke", args: { channel: "telegram", recipient: "Катя" } }, PASS_TIME_STEP],
    lab: { ctx: again.ctx },
    confirm: "no",
    expect: { flags: { declined: true, sent: false }, asked: 1, effects: [sentKinds(again, ["telegram.send", "fs.list"])], resultIncludes: /вы не подтвердили/, resultExcludes: CLAIMS_SENT },
    coversTool: "consent_revoke",
  },
  {
    tool: "consent_revoke",
    name: "все написания одного человека («Катя»/«Кате»/«Катя Любимая») снимаются, а не одно — иначе «снова спросит» было бы ложью",
    args: { channel: "telegram", recipient: "Катя" },
    lab: { ctx: prior({ consents: [{ channel: "telegram", to: "Катя" }, { channel: "telegram", to: "Кате" }, { channel: "telegram", to: "Катя Любимая" }] }) },
    expect: { ok: true, resultIncludes: ["«катя»", "«кате»", "«катя любимая»"] },
    coversTool: "consent_revoke",
  },
  {
    tool: "consent_revoke",
    name: "согласия не было — ошибка «нечего отзывать», а не «отозвано»",
    args: { channel: "telegram", recipient: "Вася" },
    lab: { ctx: prior({ consents: [{ channel: "telegram", to: "Катя" }] }) },
    expect: { ok: false, resultIncludes: /согласия на «Вася» \(telegram\) не было/, resultExcludes: /Согласие отозвано/ },
    coversTool: "consent_revoke",
  },
  {
    tool: "consent_revoke",
    name: "другой канал — согласие на telegram не отзывается через vk",
    args: { channel: "vk", recipient: "Катя" },
    lab: { ctx: prior({ consents: [{ channel: "telegram", to: "Катя" }] }) },
    expect: { ok: false, resultIncludes: /согласия на «Катя» \(vk\) не было/ },
    coversTool: "consent_revoke",
  },
  {
    tool: "consent_revoke",
    name: "чужое согласие («Оля» другого владельца) не отзывается",
    args: { channel: "telegram", recipient: "Оля" },
    lab: { ctx: prior({ foreign: [{ channel: "telegram", to: "Оля" }] }) },
    expect: { ok: false, resultIncludes: /согласия на «Оля» \(telegram\) не было/ },
    coversTool: "consent_revoke",
  },
  {
    tool: "consent_revoke",
    name: "пустой адресат — ошибка с подсказкой сверить consent_list",
    args: { channel: "telegram", recipient: "  " },
    expect: { ok: false, resultIncludes: "нужны channel и recipient" },
    coversTool: "consent_revoke",
  },
];
