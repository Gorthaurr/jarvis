/**
 * G1 · look (фасад «глаза без картинки»: elements / text / windows / context). Закон: взгляд ≠ действие — ни одного
 * эффекта на «ПК», фокус и окна не двигаются (даже при взгляде на ЧУЖОЕ окно по pid); неизвестный вид — честная
 * ошибка «Неизвестный инструмент», а не догадка.
 */
import type { ToolCase } from "../case-format.js";
import { DESK, titleOfForeground } from "./g1-fixtures.js";

/** Взгляд не оставил следов: ни эффектов, ни сдвига переднего окна/свёрнутости. */
const noTrace: NonNullable<ToolCase["expect"]["effects"]> = [(e) => e.length === 0 || `эффекты у взгляда: ${e.map((x) => x.kind).join(", ")}`];
const deskIntact: NonNullable<ToolCase["expect"]["state"]> = (s) =>
  (titleOfForeground(s) === "Чат — Telegram" && s.windows.length === 4 && s.windows.filter((w) => w.minimized).map((w) => w.title).join() === "Музыка") || `состояние окон изменилось: переднее «${titleOfForeground(s)}»`;

export const cases: ToolCase[] = [
  {
    tool: "look",
    name: "look{elements} по pid ЧУЖОГО окна (Word): элементы получены, но фокус остаётся на Telegram",
    args: { what: "elements", pid: 4004 },
    seed: DESK,
    expect: { ok: true, actionKinds: ["ui.snapshot"], flags: { observed: true, empty: false }, resultIncludes: [/^<untrusted_content source="ui-snapshot">/, '"window":"Отчёт — Word"', '"pid":4004'], effects: noTrace, state: deskIntact },
    coversTool: "look",
  },
  {
    tool: "look",
    name: "look{elements} без pid — элементы АКТИВНОГО окна (Telegram), а не Word",
    args: { what: "elements" },
    seed: DESK,
    expect: { ok: true, resultIncludes: '"window":"Чат — Telegram"', effects: noTrace, state: deskIntact },
    coversTool: "look",
  },
  {
    tool: "look",
    name: "look{text} основного монитора: видно верхнее окно, Telegram со второго монитора в кадр не попадает, следов на «ПК» нет",
    args: { what: "text", lang: "ru", monitor: "primary" },
    seed: DESK,
    expect: { ok: true, actionKinds: ["screen.ocr"], flags: { observed: true }, resultIncludes: [/^<untrusted_content source="screen-ocr">/, "Отчёт — Word (копия)"], resultExcludes: "Чат — Telegram", effects: noTrace, state: deskIntact },
    coversTool: "look",
  },
  {
    tool: "look",
    name: "look{context} без scope = active_window: выжимка окна, следов нет",
    args: { what: "context" },
    seed: { windows: [{ title: "Заметки — Блокнот", process: "notepad", text: "план на день" }] },
    expect: { ok: true, actionKinds: ["context.read"], resultIncludes: ['"scope":"active_window"', "план на день"], effects: noTrace },
    coversTool: "look",
  },
  {
    tool: "look",
    name: "look без what — «Неизвестный инструмент: look», клиенту ничего не ушло",
    args: {},
    expect: { ok: false, actionKinds: [], resultIncludes: "Неизвестный инструмент: look" },
    coversTool: "look",
  },
  {
    tool: "look",
    name: "look{what:'TEXT'} другим регистром не угадывается: отказ, OCR не запускался",
    args: { what: "TEXT" },
    seed: DESK,
    expect: { ok: false, actionKinds: [], resultIncludes: "Неизвестный инструмент", effects: noTrace },
    coversTool: "look",
  },
  {
    tool: "look",
    name: "look{text} на несуществующем мониторе: ошибка с числом мониторов, не пустой «ничего не вижу»",
    args: { what: "text", monitor: "9" },
    seed: DESK,
    expect: { ok: false, actionKinds: ["screen.ocr"], resultIncludes: /монитора «9» нет \(всего 2\)/, flags: { empty: false } },
    coversTool: "look",
  },
];
