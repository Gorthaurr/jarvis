/**
 * watch_create: настоящий сервис наблюдений (durable-стор в каталоге прогона, проверка условия без LLM). Границы:
 * мёртвый предикат не принимается «в тишину», адрес предиката проходит SSRF/DNS-суд, наблюдение с action ставится ТОЛЬКО
 * после «да» владельца (отложенное действие исполнится от его имени позже), у каждого исхода §14 свои слова, лимит 20.
 */
import type { ToolCase } from "../case-format.js";

const BTC = { what: "курс биткоина", condition: "упадёт ниже 60000", every_seconds: 300 };
const ACT = { what: "доставка заказа", condition: "статус «доставлен»", action: "напиши Кате, что доставили" };
const watch = (args: Record<string, unknown>) => ({ tool: "watch_create", args });
const bad = (name: string, predicate: unknown, reason: RegExp | string): ToolCase => ({
  tool: "watch_create",
  name,
  args: { what: "матч", condition: "найден", predicate },
  expect: { ok: false, asked: 0, resultIncludes: reason, resultExcludes: /Поставил наблюдение/ },
  coversTool: "watch_create",
});

export const cases: ToolCase[] = [
  {
    tool: "watch_create",
    name: "веб-наблюдение: ответ называет объект, условие, период и «один раз», есть id; владельца не спрашивали",
    args: BTC,
    confirm: "no",
    expect: { ok: true, asked: 0, actionKinds: [], resultIncludes: ["слежу за «курс биткоина»", "уведомлю когда «упадёт ниже 60000»", "каждые 300 с", "уведомлю один раз", /id=\S+/] },
    coversTool: "watch_create",
  },
  {
    tool: "watch_create",
    name: "период ниже минимума (5 с для веб-проверки) поднят до 30 с и это названо в ответе",
    args: { ...BTC, every_seconds: 5 },
    expect: { ok: true, resultIncludes: "каждые 30 с" },
    coversTool: "watch_create",
  },
  {
    tool: "watch_create",
    name: "continuous:true — «слежу постоянно», а не один раз",
    args: { ...BTC, continuous: true },
    expect: { ok: true, resultIncludes: "слежу постоянно", resultExcludes: "уведомлю один раз" },
    coversTool: "watch_create",
  },
  {
    tool: "watch_create",
    name: "локальный предикат (окно): период 5 с разрешён, назван «на клиенте ($0)»",
    args: { what: "матч в Dota", condition: "окно найдено", every_seconds: 5, predicate: { kind: "window", titleContains: "Dota" } },
    expect: { ok: true, resultIncludes: ["каждые 5 с", "локальным предикатом на клиенте ($0)"] },
    coversTool: "watch_create",
  },
  {
    tool: "watch_create",
    name: "gsi с булевым equals:true принят (критерий приводится к строке — иначе предикат мёртвый)",
    args: { what: "игра", condition: "идёт", predicate: { kind: "gsi", path: "map.game_state", equals: true } },
    expect: { ok: true, resultIncludes: "локальным предикатом" },
    coversTool: "watch_create",
  },
  bad("предикат с опечаткой в kind («windows») — отказ, а не наблюдение, что не сработает никогда", { kind: "windows", titleContains: "x" }, /неизвестный kind «windows»/),
  bad("gsi без path — мёртвый предикат не принимается", { kind: "gsi", equals: "1" }, /gsi: нужен path/),
  bad("gsi с объектом в equals — отказ", { kind: "gsi", path: "a.b", equals: { x: 1 } }, /equals должен быть строкой\/числом\/булевым/),
  bad("ui без role / sound без playing — отказ по структуре", { kind: "sound" }, /sound: нужен playing/),
  bad("gone не булево («true» строкой) — отказ, а не полумёртвое условие", { kind: "window", titleContains: "x", gone: "true" }, /gone должен быть булевым/),
  bad("browser-предикат на loopback — SSRF-суд адреса, наблюдение не поставлено", { kind: "browser", value: 60, url: "http://localhost:8787/admin" }, /адрес заблокирован/),
  bad("browser-предикат на имя, что указывает во внутреннюю сеть (DNS) — суд по имени, не только по строке", { kind: "browser", value: 60, url: "http://localtest.me/panel" }, /SSRF|внутрен/i),
  bad("browser-предикат с неверным оператором — отказ", { kind: "browser", value: 60, op: "~=" }, /op должен быть одним из/),
  {
    tool: "watch_create",
    name: "нет condition — отказ, наблюдение не поставлено",
    args: { what: "курс биткоина" },
    expect: { ok: false, resultIncludes: "нужны и what", resultExcludes: /Поставил наблюдение/ },
    coversTool: "watch_create",
  },
  {
    tool: "watch_create",
    name: "action + «да» владельца: наблюдение с отложенным действием поставлено, действие названо, вопрос задан РОВНО раз",
    args: ACT,
    confirm: "yes",
    expect: { ok: true, asked: 1, resultIncludes: "При срабатывании выполню: «напиши Кате, что доставили»" },
    coversTool: "watch_create",
  },
  {
    tool: "watch_create",
    name: "action + «нет» — не поставлено: «Отменено пользователем», наблюдения в списке нет",
    args: ACT,
    confirm: "no",
    expect: { ok: false, asked: 1, resultIncludes: /Отменено пользователем \(наблюдение с действием\)/, resultExcludes: /Поставил наблюдение/ },
    coversTool: "watch_create",
  },
  {
    tool: "watch_create",
    name: "action + вопрос истёк — «не ответили», а не «отменено пользователем»",
    args: ACT,
    confirm: "expire",
    expect: { ok: false, asked: 1, resultIncludes: /вы не ответили на подтверждение, оно истекло/, resultExcludes: [/Отменено пользователем/, /Поставил наблюдение/] },
    coversTool: "watch_create",
  },
  {
    tool: "watch_create",
    name: "action + владельца не смогли спросить — «не смог спросить», отказ ему не приписан",
    args: ACT,
    confirm: "undelivered",
    expect: { ok: false, asked: 1, resultIncludes: /не смог спросить вашего подтверждения/, resultExcludes: [/Отменено пользователем/, /Поставил наблюдение/] },
    coversTool: "watch_create",
  },
  {
    tool: "watch_create",
    name: "action длиннее 500 символов — отказ до вопроса владельцу",
    args: { ...ACT, action: "напиши ".concat("Кате ".repeat(120)) },
    confirm: "yes",
    expect: { ok: false, asked: 0, resultIncludes: "слишком длинный (кап 500" },
    coversTool: "watch_create",
  },
  {
    tool: "watch_create",
    name: "action пустой строкой — отказ, а не наблюдение «без действия»",
    args: { ...ACT, action: "   " },
    confirm: "yes",
    expect: { ok: false, asked: 0, resultIncludes: "action должен быть непустой строкой" },
    coversTool: "watch_create",
  },
  {
    tool: "watch_create",
    name: "лимит 20 активных на владельца: 21-е не ставится, просит снять одно",
    args: BTC,
    before: Array.from({ length: 20 }, (_, i) => watch({ what: `объект ${i}`, condition: `условие ${i}` })),
    expect: { ok: false, resultIncludes: /Слишком много активных наблюдений.*watch_cancel/, resultExcludes: /Поставил наблюдение/ },
    coversTool: "watch_create",
  },
];
