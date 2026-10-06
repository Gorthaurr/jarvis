/**
 * telegram_send, настоящий FakeDesktop: КОМУ уходит. Тёзки — не угадываем, peer — точно тому, кого выбрал владелец;
 * нет контакта / не залогинен — честная ошибка; частая отправка режется cadence, клиент при этом не трогается.
 */
import type { ToolCase } from "../case-format.js";
import { CLAIMS_SENT, KATYA, tgSeed } from "./comm-fixtures.js";

const ONE = tgSeed([KATYA]);
const NAMESAKES = tgSeed([{ title: "Катя Любимая", peerId: "5" }, { title: "Катя Работа", peerId: "6" }]);
const SEND = { to: "Катя", text: "иду, буду через пять минут" };

export const cases: ToolCase[] = [
  {
    tool: "telegram_send",
    name: "тёзки: наугад не шлёт — просит спросить владельца, в чаты ничего не написано",
    args: { to: "Катя", text: "привет" },
    seed: NAMESAKES,
    confirm: "yes",
    expect: {
      ok: false,
      flags: { sent: false, uncertain: false },
      actionKinds: ["telegram.send"],
      effects: [{ none: "telegram.send" }],
      resultIncludes: ["ТЁЗКИ", "Катя Любимая", "id=5", "Катя Работа", "id=6", "СПРОСИ владельца"],
      resultExcludes: [CLAIMS_SENT, "[tg-resolve]"],
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "peer выбранного тёзки — уходит ТОЧНО «Катя Работа», второй Кате не пишет",
    args: { to: "Катя", text: "привет", peer: "6" },
    seed: NAMESAKES,
    confirm: "yes",
    expect: {
      ok: true,
      flags: { sent: true },
      actionKinds: ["telegram.send"],
      effects: [{ has: "telegram.send", count: 1, detail: { chatTitle: "Катя Работа", peerId: "6", text: "привет" } }],
      resultIncludes: "Отправлено «Катя Работа»",
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "контакта нет — честная ошибка со списком видимых чатов, без служебного маркера",
    args: { to: "Вася", text: "привет" },
    seed: ONE,
    confirm: "yes",
    expect: {
      ok: false,
      flags: { sent: false },
      effects: [{ none: "telegram.send" }],
      resultIncludes: ["Не нашёл в Telegram контакт «Вася»", "Катя Иванова"],
      resultExcludes: [CLAIMS_SENT, "[tg-resolve]"],
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "Telegram не залогинен — ошибка и окно входа, а не «отправлено»",
    args: SEND,
    seed: tgSeed([KATYA], false),
    confirm: "yes",
    expect: {
      ok: false,
      flags: { sent: false, uncertain: false },
      actionKinds: ["telegram.send"],
      effects: [{ has: "jbrowser.login_window" }, { none: "telegram.send" }],
      resultIncludes: /не залогинен/,
      resultExcludes: CLAIMS_SENT,
    },
    coversTool: "telegram_send",
  },
  {
    tool: "telegram_send",
    name: "второе сообщение сразу за первым (<3 с) — cadence(burst) не пускает, клиенту не ушло",
    args: { to: "Катя", text: "и ещё одно, совсем другое по смыслу" },
    seed: ONE,
    before: [{ tool: "telegram_send", args: SEND, confirm: "yes" }],
    confirm: "yes",
    expect: {
      ok: false,
      flags: { sent: false },
      asked: 0,
      actionKinds: [],
      resultIncludes: /cadence-лимит \(burst\)/,
      resultExcludes: CLAIMS_SENT,
    },
    coversTool: "telegram_send",
  },
];
