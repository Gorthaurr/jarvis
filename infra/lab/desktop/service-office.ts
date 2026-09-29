/**
 * office.excel / office.word FakeDesktop: документы живут в виртуальной ФС как двоичные файлы с меткой формата
 * (PK-заголовок + JSON модели) — fs.list их видит, fs.read честно «бинарный», а содержимое читает office.* (или
 * readOfficeDoc в проверках сценария). Поведение и формы — как у COM-скриптов office.ts, включая их острые углы:
 * read несуществующего файла НЕ создаёт файл и отдаёт пустую книгу; append_row считает строки UsedRange, а не индекс.
 * Не моделируем: формулы, форматирование, даты (Value2 → строки). Нет Excel/Word в installedApps → как без Office.
 */
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import type { DesktopCore, KindHandlers } from "./core.js";
import { parentOf, pathDenial, putFile, str, vpath } from "./service-state.js";

type Meta = { commandId: string; timeoutMs: number };
export type ExcelDoc = { kind: "xlsx"; sheets: Array<{ name: string; cells: Record<string, string> }> };
export type WordDoc = { kind: "docx"; text: string };
export type OfficeDoc = ExcelDoc | WordDoc;

const MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
const MAX_RANGE_CELLS = 100_000;
const NO_OFFICE = "Office COM не вернул результат (возможно, Office не установлен)";

const encode = (d: OfficeDoc): Buffer => Buffer.concat([MAGIC, Buffer.from(JSON.stringify(d), "utf8")]);

function decode(b: Buffer): OfficeDoc | null {
  if (b.length < MAGIC.length || !b.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  try {
    const d = JSON.parse(b.subarray(MAGIC.length).toString("utf8")) as OfficeDoc;
    return d && (d.kind === "xlsx" || d.kind === "docx") ? d : null;
  } catch {
    return null;
  }
}

/** Для проверок сценария: содержимое документа по пути (или null). */
export function readOfficeDoc(core: DesktopCore, path: string): OfficeDoc | null {
  const b = core.fs.files.get(vpath(core, path));
  return b ? decode(b) : null;
}

const colNum = (c: string): number => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
function colName(n: number): string {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}
function addr(a: string): { c: number; r: number } | null {
  const m = /^([A-Za-z]{1,3})(\d{1,7})$/u.exec(a.trim());
  return m ? { c: colNum(m[1]!.toUpperCase()), r: Number(m[2]) } : null;
}

/** Границы занятой области листа (как UsedRange); пустой лист — A1:A1. */
function used(cells: Record<string, string>): { c1: number; r1: number; c2: number; r2: number; empty: boolean } {
  const pts = Object.keys(cells).map(addr).filter((p): p is { c: number; r: number } => p !== null);
  if (!pts.length) return { c1: 1, r1: 1, c2: 1, r2: 1, empty: true };
  return { c1: Math.min(...pts.map((p) => p.c)), r1: Math.min(...pts.map((p) => p.r)), c2: Math.max(...pts.map((p) => p.c)), r2: Math.max(...pts.map((p) => p.r)), empty: false };
}

export function officeHandlers(core: DesktopCore): KindHandlers {
  const fail = (m: Meta, msg: string): ActionResult => core.fail(m.commandId, "runtime", msg);

  /** Открыть/создать документ: нет файла → новый (в памяти), файл не нашего формата → ошибка открытия. */
  function open(path: string, kind: OfficeDoc["kind"], write: boolean): { abs: string; doc: OfficeDoc; existed: boolean } | string {
    const abs = vpath(core, path);
    const denied = pathDenial(abs, write);
    if (denied) return denied;
    const raw = core.fs.files.get(abs);
    if (!raw) return { abs, existed: false, doc: kind === "xlsx" ? { kind, sheets: [{ name: "Sheet1", cells: {} }] } : { kind, text: "" } };
    const doc = decode(raw);
    if (!doc || doc.kind !== kind) return `${kind === "xlsx" ? "Excel" : "Word"} не смог открыть «${abs}»: файл не является ${kind === "xlsx" ? "книгой Excel" : "документом Word"}`;
    return { abs, doc, existed: true };
  }

  function save(abs: string, doc: OfficeDoc, tool: string): string | null {
    if (!core.fs.dirs.has(parentOf(abs))) return `${tool}: не удалось сохранить «${abs}» — каталога нет`;
    putFile(core, abs, encode(doc), tool);
    return null;
  }

  return {
    "office.excel": (cmd, meta) => {
      const c = cmd as Extract<ActionCommand, { kind: "office.excel" }>;
      if (!core.installedApps.has("excel")) return fail(meta, NO_OFFICE);
      const o = open(c.path, "xlsx", c.op !== "read");
      if (typeof o === "string") return fail(meta, o);
      const book = o.doc as ExcelDoc;
      let sheet = c.sheet ? book.sheets.find((s) => s.name === c.sheet) : book.sheets[0];
      if (!sheet) book.sheets.push((sheet = { name: c.sheet ?? "Sheet1", cells: {} }));
      const data: Record<string, unknown> = { ok: true, op: c.op };

      if (c.op === "read") {
        const u = used(sheet.cells);
        let { c1, r1, c2, r2 } = u;
        if (c.range) {
          const [a, b = a] = c.range.split(":");
          const pa = addr(a ?? ""), pb = addr(b ?? "");
          if (!pa || !pb) return fail(meta, `Excel: неверный диапазон «${c.range}»`);
          ({ c1, r1, c2, r2 } = { c1: Math.min(pa.c, pb.c), r1: Math.min(pa.r, pb.r), c2: Math.max(pa.c, pb.c), r2: Math.max(pa.r, pb.r) });
        }
        if ((c2 - c1 + 1) * (r2 - r1 + 1) > MAX_RANGE_CELLS) return fail(meta, `Excel: диапазон больше ${MAX_RANGE_CELLS} ячеек — читай окнами`);
        data.values = Array.from({ length: r2 - r1 + 1 }, (_r, i) => Array.from({ length: c2 - c1 + 1 }, (_c, j) => sheet!.cells[`${colName(c1 + j)}${r1 + i}`] ?? ""));
        core.effect("office.excel", { op: "read", path: o.abs, existed: o.existed });
        return core.ok(meta.commandId, data);
      }
      if (c.op === "write_cell") {
        const p = c.cell ? addr(c.cell) : null;
        if (!p) return fail(meta, `Excel: неверная ячейка «${str(c.cell)}»`);
        const key = `${colName(p.c)}${p.r}`;
        if (str(c.value) === "") delete sheet.cells[key];
        else sheet.cells[key] = str(c.value);
        data.cell = c.cell;
      } else if (c.op === "append_row") {
        const u = used(sheet.cells);
        const row = u.empty ? 1 : u.r2 - u.r1 + 1 + 1; // как в COM-скрипте: UsedRange.Rows.Count + 1
        (c.row ?? []).forEach((v, i) => {
          if (str(v) !== "") sheet!.cells[`${colName(i + 1)}${row}`] = str(v);
        });
        data.row = row;
      } else return fail(meta, `Excel: неизвестная операция «${str((c as { op?: unknown }).op)}»`);

      const err = save(o.abs, book, "office.excel");
      if (err) return fail(meta, err);
      core.effect("office.excel", { op: c.op, path: o.abs, sheet: sheet.name, existed: o.existed, ...(c.op === "write_cell" ? { cell: c.cell } : { row: data.row }) });
      return core.ok(meta.commandId, data);
    },

    "office.word": (cmd, meta) => {
      const c = cmd as Extract<ActionCommand, { kind: "office.word" }>;
      if (!core.installedApps.has("winword")) return fail(meta, NO_OFFICE);
      const o = open(c.path, "docx", c.op !== "read");
      if (typeof o === "string") return fail(meta, o);
      const doc = o.doc as WordDoc;
      if (c.op === "read") {
        core.effect("office.word", { op: "read", path: o.abs, existed: o.existed });
        return core.ok(meta.commandId, { ok: true, op: "read", text: `${doc.text}\r` }); // Content.Text заканчивается меткой абзаца
      }
      if (c.op === "write") doc.text = str(c.text);
      else if (c.op === "append") doc.text = doc.text ? `${doc.text}\r${str(c.text)}` : str(c.text);
      else return fail(meta, `Word: неизвестная операция «${str((c as { op?: unknown }).op)}»`);
      const err = save(o.abs, doc, "office.word");
      if (err) return fail(meta, err);
      core.effect("office.word", { op: c.op, path: o.abs, chars: str(c.text).length, existed: o.existed });
      return core.ok(meta.commandId, { ok: true, op: c.op });
    },
  };
}
