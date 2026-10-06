/**
 * G1 · screen_selection{start|clear}: попросить владельца обвести область и снять рамку. Исходы разведены по виновнику
 * (обвёл / не успел, вуаль ещё стоит / нечего снимать); машинный/проактивный ход просить владельца не вправе;
 * waitMs — число (строка коэрсится, мусор — ошибка, потолок клампится на сервере).
 */
import type { ToolCase } from "../case-format.js";
import { NOTEPAD_SEED, ownerLab } from "./g1-fixtures.js";

const PLAN = { x: 400, y: 200, w: 100, h: 100, monitorIndex: 0 };
/** Владелец обведёт область через `afterMs` виртуальных мс после start. */
const willDrawIn = (afterMs: number) => ownerLab(NOTEPAD_SEED, (d) => d.userAction("selection.plan", { ...PLAN, afterMs }));
const START = (waitMs?: unknown) => ({ op: "start", ...(waitMs === undefined ? {} : { waitMs }) });
const noShot = { none: "screen.capture" } as const;

export const cases: ToolCase[] = [
  {
    tool: "screen_selection",
    name: "start без ожидания: вуаль открыта, ответ «ждём» и помечен veiled (опрос под вуалью — не топтание)",
    args: START(),
    seed: NOTEPAD_SEED,
    expect: { ok: true, actionKinds: ["screen.selection"], flags: { veiled: true }, resultIncludes: "Оверлей выделения открыт — ждём, обведёт ли владелец область", effects: [noShot] },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "start{waitMs}: владелец обвёл в срок — область названа, вуаль снята (veiled=false)",
    args: START(5000),
    seed: NOTEPAD_SEED,
    lab: willDrawIn(2000),
    expect: { ok: true, flags: { veiled: false }, resultIncludes: "Владелец обвёл область: 100×100 на «Монитор 1»", resultExcludes: /ждём|не обвёл/ },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "waitMs строкой «5000» коэрсится в число: ждали и дождались (раньше молча отбрасывалось → «ждём» при нулевом ожидании)",
    args: START("5000"),
    seed: NOTEPAD_SEED,
    lab: willDrawIn(2000),
    expect: { ok: true, resultIncludes: "Владелец обвёл область: 100×100", resultExcludes: "Оверлей выделения открыт — ждём" },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "start{waitMs}: владелец не успел — честный таймаут, вуаль ещё открыта, догадок о намерении нет",
    args: START(3000),
    seed: NOTEPAD_SEED,
    lab: willDrawIn(9000),
    expect: { ok: true, flags: { veiled: true }, resultIncludes: ["Прождал 3 с", "вуаль оверлея ещё открыта", "Не придумывай, что он имел в виду"], resultExcludes: "Владелец обвёл область" },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "waitMs в миллиард мс режется потолком сервера до 120 с (не держим tool-вызов часами)",
    args: START(1_000_000_000),
    seed: NOTEPAD_SEED,
    expect: { ok: true, resultIncludes: "Прождал 120 с", resultExcludes: /1000000/ },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "waitMs мусором («скоро») — ошибка типа, клиенту ничего не ушло",
    args: START("скоро"),
    seed: NOTEPAD_SEED,
    expect: { ok: false, actionKinds: [], resultIncludes: /waitMs должен быть числом миллисекунд/ },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "проактивный ход не вправе просить владельца обводить область: отказ, вуаль не открывалась",
    args: START(),
    seed: NOTEPAD_SEED,
    lab: { ctx: { origin: "proactive" } },
    expect: { ok: false, actionKinds: [], resultIncludes: /только в ответ на ЕГО реплику/ },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "машинный ход (watch-действие ночью) — то же: вуаль висела бы бессрочно, поэтому отказ до клиента",
    args: START(),
    seed: NOTEPAD_SEED,
    lab: { ctx: { machineTurn: true } },
    expect: { ok: false, actionKinds: [], resultIncludes: /только в ответ на ЕГО реплику.*screen_capture/ },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "start при свежей рамке (<5 с) не открывает оверлей заново: «уже только что обвёл»",
    args: START(),
    seed: NOTEPAD_SEED,
    lab: ownerLab(NOTEPAD_SEED, (d) => d.userAction("selection", PLAN)),
    expect: { ok: true, resultIncludes: "Владелец уже только что обвёл область: 100×100", flags: { veiled: false } },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "clear: рамка снята — так и сказано, без лишних слов про вуаль",
    args: { op: "clear" },
    seed: NOTEPAD_SEED,
    lab: ownerLab(NOTEPAD_SEED, (d) => d.userAction("selection", PLAN)),
    expect: { ok: true, resultIncludes: "Выделение снято — рамки на экране больше нет.", resultExcludes: /вуаль/ },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "clear во время рисования: гашение вуали названо действием (владелец мог тянуть рамку)",
    args: { op: "clear" },
    seed: NOTEPAD_SEED,
    before: [{ tool: "screen_selection", args: START() }],
    expect: { ok: true, resultIncludes: /Закрыл режим выделения: вуаль погашена, область владелец обвести не успел/ },
    coversTool: "screen_selection",
  },
  {
    tool: "screen_selection",
    name: "clear, когда снимать нечего: «Снимать было нечего», а не ложное «снял»",
    args: { op: "clear" },
    seed: NOTEPAD_SEED,
    expect: { ok: true, resultIncludes: "Снимать было нечего: активного выделения не было.", resultExcludes: /Выделение снято/ },
    coversTool: "screen_selection",
  },
];
