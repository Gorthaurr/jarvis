/**
 * memory_write: запись факта в память арендатора. Проверяем ФАКТ у сервера (журнал записей шпиона, профиль), а не «Запомнил»:
 * вид эпизода и провенанс, мост в профиль, дедуп, партиция арендаторов, гейты «чужая реплика»/dev-сессия, хук противоречий.
 */
import type { ToolCase } from "../case-format.js";
import { all, cur, factsOf, hookLlm, is, lazyCtx, spy, uid } from "./mem-fixtures.js";

const JOB = "Владелец работает звукорежиссёром в студии";
const w = () => cur.spy!.writes;

export const cases: ToolCase[] = [
  {
    tool: "memory_write",
    name: "факт записан: эпизод fact с провенансом model у своего арендатора, мост в профиль",
    args: { content: JOB, kind: "semantic" },
    lab: { ctx: lazyCtx("mw1", { episodic: (u) => spy(u) }) },
    expect: {
      ok: true,
      resultIncludes: "Запомнил",
      resultExcludes: "Уже помню",
      actionKinds: [],
      state: () =>
        all(
          is(w().length === 1 && w()[0]!.kind === "fact" && w()[0]!.source === "model" && w()[0]!.userId === uid("mw1") && w()[0]!.text === JOB, `записи: ${JSON.stringify(w())}`),
          is(factsOf("mw1").includes(JOB), `профиль: ${JSON.stringify(factsOf("mw1"))}`),
        ),
    },
    coversTool: "memory_write",
  },
  {
    tool: "memory_write",
    name: "episodic → событие: пишется в эпизодику, но в профиль-факты НЕ идёт",
    args: { content: "Вчера ходили с Катей в кино", kind: "episodic" },
    lab: { ctx: lazyCtx("mw2", { episodic: (u) => spy(u) }) },
    expect: { ok: true, resultIncludes: "Запомнил", state: () => is(w().length === 1 && w()[0]!.kind === "event" && factsOf("mw2").length === 0, `записи ${JSON.stringify(w())}, профиль ${JSON.stringify(factsOf("mw2"))}`) },
    coversTool: "memory_write",
  },
  {
    tool: "memory_write",
    name: "тот же факт второй раз — «уже помню», в эпизодику не дублируется",
    args: { content: JOB, kind: "semantic" },
    before: [{ tool: "memory_write", args: { content: JOB, kind: "semantic" } }],
    lab: { ctx: lazyCtx("mw3", { episodic: (u) => spy(u) }) },
    expect: { ok: true, resultIncludes: "Уже помню", resultExcludes: "Запомнил", state: () => is(w().length === 1, `записей ${w().length}, ждали 1`) },
    coversTool: "memory_write",
  },
  {
    tool: "memory_write",
    name: "пустой content — честная ошибка, ничего не записано",
    args: { content: "   ", kind: "semantic" },
    lab: { ctx: lazyCtx("mw4", { episodic: (u) => spy(u) }) },
    expect: { ok: false, resultIncludes: "пустой content", resultExcludes: "Запомнил", state: () => is(w().length === 0 && factsOf("mw4").length === 0, `записи ${JSON.stringify(w())}`) },
    coversTool: "memory_write",
  },
  {
    tool: "memory_write",
    name: "реплика без «Джарвис» (чужая речь) — отказ политикой, память не тронута",
    args: { content: "Владелец обожает громкую музыку по ночам", kind: "semantic" },
    lab: { ctx: lazyCtx("mw5", { episodic: (u) => spy(u) }, { unaddressedTurn: true }) },
    expect: { flags: { declined: true }, resultIncludes: /без обращения «Джарвис»/, resultExcludes: "Запомнил", actionKinds: [], state: () => is(w().length === 0 && factsOf("mw5").length === 0, `записи ${JSON.stringify(w())}`) },
    coversTool: "memory_write",
  },
  {
    tool: "memory_write",
    name: "dev-сессия не пишет в память владельца: запись пропущена и названа пропущенной",
    args: { content: JOB, kind: "semantic" },
    lab: { ctx: lazyCtx("mw6", { episodic: (u) => spy(u) }, { devSession: true }) },
    expect: { ok: true, resultIncludes: /Dev-сессия.*пропущена/, resultExcludes: "Запомнил", state: () => is(w().length === 0 && factsOf("mw6").length === 0, `записи ${JSON.stringify(w())}`) },
    coversTool: "memory_write",
  },
  {
    tool: "memory_write",
    name: "тот же текст у ДРУГОГО арендатора — не дубль: свой факт записан, чужой нетронут",
    args: { content: JOB, kind: "semantic" },
    lab: { ctx: lazyCtx("mw7", { episodic: (u) => spy(u, { other: [JOB] }) }) },
    expect: { ok: true, resultIncludes: "Запомнил", resultExcludes: "Уже помню", state: () => is(w().length === 1 && w()[0]!.userId === uid("mw7") && cur.spy!.size === 2, `записи ${JSON.stringify(w())}, всего ${cur.spy!.size}`) },
    coversTool: "memory_write",
  },
  {
    tool: "memory_search",
    name: "хук противоречий: новая работа отменила старую — старый факт не всплывает, из профиля ушёл",
    args: { query: "Работает в Сбере программистом" },
    before: [
      { tool: "memory_write", args: { content: "Работает в Сбере программистом", kind: "semantic" } },
      { tool: "memory_write", args: { content: "Работает в Яндексе программистом", kind: "semantic" } },
    ],
    lab: { ctx: lazyCtx("mw8", { episodic: (u) => spy(u, { settleMs: 30 }) }, { contradiction: hookLlm("[1]") }) },
    expect: {
      ok: true,
      resultIncludes: "Яндексе",
      resultExcludes: "Сбере программистом (",
      state: () => is(factsOf("mw8").join("|") === "Работает в Яндексе программистом", `профиль: ${JSON.stringify(factsOf("mw8"))}`),
    },
    coversTool: "memory_write",
  },
  {
    tool: "memory_search",
    name: "хук противоречий недоступен (стаб) — «не проверено» ≠ «противоречит»: старый факт цел",
    args: { query: "Работает в Сбере программистом" },
    before: [
      { tool: "memory_write", args: { content: "Работает в Сбере программистом", kind: "semantic" } },
      { tool: "memory_write", args: { content: "Работает в Яндексе программистом", kind: "semantic" } },
    ],
    lab: { ctx: lazyCtx("mw9", { episodic: (u) => spy(u, { settleMs: 30 }) }, { contradiction: hookLlm("[1]", true) }) },
    expect: { ok: true, resultIncludes: ["Сбере", "Яндексе"], state: () => is(factsOf("mw9").length === 2, `профиль: ${JSON.stringify(factsOf("mw9"))}`) },
    coversTool: "memory_write",
  },
  {
    tool: "memory_write",
    name: "номер банковской карты с CVV не должен оседать в памяти (красная линия §0)",
    args: { content: "Карта владельца 4111 1111 1111 1111, срок 12/29, CVV 123", kind: "semantic" },
    lab: { ctx: lazyCtx("mw10", { episodic: (u) => spy(u) }) },
    expect: { ok: false, resultExcludes: "Запомнил", actionKinds: [], state: () => is(w().length === 0 && factsOf("mw10").length === 0, `записано: ${JSON.stringify(w())}`) },
    coversTool: "memory_write",
    skip: "ДЕФЕКТ: memoryWrite (dispatch.ts) не применяет гард платёжных данных — карта с CVV пишется в эпизодику и в profile.facts (уходит в системный промпт каждого хода); в описании схемы запрет есть, в сервере нет",
  },
];
