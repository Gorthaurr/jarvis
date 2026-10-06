/**
 * order_place, ЗАЩИТЫ ДО клиента: красная линия карты (§0), потолок траты, обязательные поля. Всё это отказ ДО вопроса
 * владельцу и до клиента: ни «да», ни «нет» здесь не звучат, order.place не уходит.
 */
import type { ToolCase } from "../case-format.js";

const ITEMS = [{ name: "Маргарита", qty: 2, price: 450 }];
const ORDER = { vendor: "Пиццерия", items: ITEMS, total: 900 };
const NOTHING = { flags: { sent: false }, actionKinds: [] as string[], resultExcludes: /Заказ оформлен/ };

export const cases: ToolCase[] = [
  {
    tool: "order_place",
    name: "красная линия §0: номер карты в позиции заказа — отказ до вопроса и до клиента",
    args: { ...ORDER, items: [{ name: "Маргарита", note: "карта 4111 1111 1111 1111" }] },
    confirm: "yes",
    expect: { ok: false, ...NOTHING, asked: 0, resultIncludes: /красная линия карты \(§0\)/ },
    coversTool: "order_place",
  },
  {
    tool: "order_place",
    name: "красная линия §0: поле cvv в заказе — отказ по ключу, даже без номера",
    args: { ...ORDER, items: [{ name: "Маргарита", cvv: "123" }] },
    confirm: "yes",
    expect: { ok: false, ...NOTHING, asked: 0, resultIncludes: /красная линия карты \(§0\).*cvv/ },
    coversTool: "order_place",
  },
  {
    tool: "order_place",
    name: "потолок траты: 6000 > 5000 — заказ заблокирован без вопроса владельцу",
    args: { ...ORDER, total: 6000 },
    confirm: "yes",
    expect: { ok: false, ...NOTHING, asked: 0, resultIncludes: /Заказ не оформлен \(blocked\): сумма 6000 выше потолка 5000/ },
    coversTool: "order_place",
  },
  {
    tool: "order_place",
    name: "сумма не число («12 500») — fail-closed: блок, а не проход мимо потолка",
    args: { ...ORDER, total: "12 500" },
    confirm: "yes",
    expect: { ok: false, ...NOTHING, asked: 0, resultIncludes: /сумма не распознана/ },
    coversTool: "order_place",
  },
  {
    tool: "order_place",
    name: "отрицательная сумма — блок, как и нераспознанная",
    args: { ...ORDER, total: -100 },
    confirm: "yes",
    expect: { ok: false, ...NOTHING, asked: 0, resultIncludes: /Заказ не оформлен \(blocked\)/ },
    coversTool: "order_place",
  },
  {
    tool: "order_place",
    name: "пустые позиции — ошибка до вопроса и до клиента",
    args: { ...ORDER, items: [] },
    confirm: "yes",
    expect: { ok: false, ...NOTHING, asked: 0, resultIncludes: "нужны vendor и items" },
    coversTool: "order_place",
  },
  {
    tool: "order_place",
    name: "сумма не указана вовсе — fail-closed как у нераспознанной, а не «на 0» мимо потолка",
    args: { vendor: "Пиццерия", items: [{ name: "Маргарита", qty: 2, price: 45000 }] },
    confirm: "yes",
    expect: { ok: false, ...NOTHING, asked: 0, resultIncludes: /Заказ не оформлен \(blocked\)/ },
    coversTool: "order_place",
    skip: "ДЕФЕКТ: orderPlace берёт Number(input.total ?? 0) (messaging.ts:449) — без total сумма = 0 проходит потолок, владельцу показывают «на 0», order.place уходит клиенту",
  },
];
