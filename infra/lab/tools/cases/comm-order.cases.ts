/**
 * order_place: деньги. Красная линия карты (§0), потолок траты, все исходы §14, честность исхода. Настоящий клиент
 * оформлять заказы ещё не умеет (M7) — FakeDesktop отвечает так же, поэтому «заказ оформлен» в кейсах моделируется
 * ответом клиента-обёртки (fault `answer`), а «не умеет» проверяется на настоящем FakeDesktop.
 */
import type { ToolCase } from "../case-format.js";
import { faultyClient, sentKinds, sentPayload } from "./comm-wire.js";

const ITEMS = [{ name: "Маргарита", qty: 2, price: 450 }];
const ORDER = { vendor: "Пиццерия", items: ITEMS, total: 900 };
const NOTHING = { flags: { sent: false }, actionKinds: [] as string[], resultExcludes: /Заказ оформлен/ };
const placed = () => faultyClient(undefined, [{ kind: "order.place", mode: "answer", data: { orderId: "ord-1" } }]);
const okWire = placed();
const dupWire = placed();
const lost = faultyClient(undefined, [{ kind: "order.place", mode: "lose-reply" }]);
const down = faultyClient(undefined, [{ kind: "order.place", mode: "drop", code: "channel_down", message: "канал недоступен" }]);

export const cases: ToolCase[] = [
  {
    tool: "order_place",
    name: "«да» — заказ ушёл клиенту с теми же vendor/items/total, sent:true",
    args: ORDER,
    lab: { ctx: okWire.ctx },
    confirm: "yes",
    expect: { ok: true, flags: { sent: true, declined: false }, asked: 1, effects: [sentKinds(okWire, ["order.place"]), sentPayload(okWire, "order.place", { vendor: "Пиццерия", total: 900, items: ITEMS })], resultIncludes: "Заказ оформлен в «Пиццерия» на 900." },
    coversTool: "order_place",
  },
  {
    tool: "order_place",
    name: "владелец «нет» — заказ не оформлен, клиенту ничего",
    args: ORDER,
    confirm: "no",
    expect: { ...NOTHING, flags: { sent: false, declined: true }, asked: 1, resultIncludes: /Отменено пользователем \(заказ\)/ },
    coversTool: "order_place",
  },
  {
    tool: "order_place",
    name: "окно подтверждения истекло — «не ответили», заказ не оформлен",
    args: ORDER,
    confirm: "expire",
    expect: { ...NOTHING, flags: { sent: false, declined: true }, asked: 1, resultIncludes: /вы не ответили на подтверждение, оно истекло/, resultExcludes: /Отменено пользователем|Заказ оформлен/ },
    coversTool: "order_place",
  },
  {
    tool: "order_place",
    name: "владельца не смогли спросить — «не смог спросить» + channelDown, отказ ему не приписан",
    args: ORDER,
    confirm: "undelivered",
    expect: { ...NOTHING, flags: { sent: false, declined: true, channelDown: true }, asked: 1, resultIncludes: /не смог спросить вашего подтверждения/, resultExcludes: /Отменено пользователем|Заказ оформлен/ },
    coversTool: "order_place",
  },
  {
    tool: "order_place",
    name: "настоящий клиент оформлять не умеет (M7): «Заказ не оформлен», order.attempt placed:false, денег нет",
    args: ORDER,
    confirm: "yes",
    expect: {
      ok: false,
      flags: { sent: false, uncertain: false },
      asked: 1,
      actionKinds: ["order.place"],
      effects: [{ has: "order.attempt", detail: { vendor: "Пиццерия", placed: false } }, { none: "order.place" }],
      resultIncludes: /Заказ не оформлен \(error\).*не реализован/,
      resultExcludes: /Заказ оформлен/,
    },
    coversTool: "order_place",
  },
  {
    tool: "order_place",
    name: "тот же заказ второй раз — идемпотентность: клиенту order.place ушёл ровно один раз",
    args: ORDER,
    before: [{ tool: "order_place", args: ORDER, confirm: "yes" }],
    lab: { ctx: dupWire.ctx },
    confirm: "yes",
    expect: { ok: false, flags: { sent: false }, effects: [sentKinds(dupWire, ["order.place"])], resultIncludes: /Заказ не оформлен \(duplicate\)/, resultExcludes: /Заказ оформлен/ },
    coversTool: "order_place",
  },
  {
    tool: "order_place",
    name: "канал ПК мёртв (channel_down) — channelDown для петли, заказ не оформлен",
    args: ORDER,
    lab: { ctx: down.ctx },
    confirm: "yes",
    expect: { ok: false, flags: { channelDown: true, sent: false }, effects: [sentKinds(down, ["order.place"])], resultIncludes: /канал с ПК недоступен/, resultExcludes: /Заказ оформлен/ },
    coversTool: "order_place",
  },
  {
    tool: "order_place",
    name: "клиент оформил, а ответ потерян — исход НЕИЗВЕСТЕН: uncertain, а не «Заказ не оформлен» (иначе повтор = второй заказ)",
    args: ORDER,
    lab: { ctx: lost.ctx },
    confirm: "yes",
    expect: { ok: false, flags: { uncertain: true, sent: false }, effects: [sentKinds(lost, ["order.place"])], resultIncludes: /Не знаю/, resultExcludes: [/Заказ оформлен/, /Заказ не оформлен/] },
    coversTool: "order_place",
    skip: "ДЕФЕКТ: orders.placeOrder сводит timeout/обрыв к status:error → «Заказ не оформлен» (messaging.ts:474), третьего исхода нет; ключ идемпотентности не ставится — повтор создаст второй заказ",
  },
];
