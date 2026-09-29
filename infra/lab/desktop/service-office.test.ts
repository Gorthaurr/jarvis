import { describe, expect, it } from "vitest";
import { readOfficeDoc } from "./service-handlers.js";
import { errOf, rig } from "./service-rig.js";

const xl = (over: Record<string, unknown>) => ({ kind: "office.excel" as const, op: "read" as const, path: "Documents/book.xlsx", ...over }) as never;
const wd = (over: Record<string, unknown>) => ({ kind: "office.word" as const, op: "read" as const, path: "Documents/doc.docx", ...over }) as never;
const values = (r: { data?: unknown }): string[][] => (r.data as { values: string[][] }).values;

describe("office.excel", () => {
  it("write_cell → read: значение читается обратно строкой; форма {ok, op, cell}", async () => {
    const r = rig();
    const w = await r.call(xl({ op: "write_cell", cell: "B2", value: "42" }));
    expect(w).toMatchObject({ ok: true, data: { ok: true, op: "write_cell", cell: "B2" } });
    expect(values(await r.call(xl({})))).toEqual([["42"]]); // UsedRange = одна занятая ячейка
    expect(values(await r.call(xl({ range: "A1:C2" })))).toEqual([["", "", ""], ["", "42", ""]]);
  });

  it("файл реально появляется в виртуальной ФС (бинарный), а fs-эффект называет источник", async () => {
    const r = rig();
    await r.call(xl({ op: "write_cell", cell: "A1", value: "x" }));
    const path = "C:/Users/lab/Documents/book.xlsx";
    expect(r.core.snapshot().files[path]).toMatchObject({ binary: expect.any(Number) });
    expect(r.kinds("fs.write")[0]).toMatchObject({ path, via: "office.excel", created: true });
    expect(readOfficeDoc(r.core, path)).toMatchObject({ kind: "xlsx" });
  });

  it("append_row: пустой лист → строка 1, дальше — следующая; параллельные вызовы не теряют строки", async () => {
    const r = rig();
    const rows = await Promise.all([r.call(xl({ op: "append_row", row: ["a", "1"] })), r.call(xl({ op: "append_row", row: ["b", "2"] }))]);
    expect(rows.map((x) => (x.data as { row: number }).row).sort()).toEqual([1, 2]);
    expect(values(await r.call(xl({})))).toEqual([["a", "1"], ["b", "2"]]);
  });

  it("append_row считает строки UsedRange (острый угол COM-скрипта): данные с 3-й строки → следующая вставка 2-я по счёту", async () => {
    const r = rig();
    await r.call(xl({ op: "write_cell", cell: "A3", value: "x" }));
    const res = await r.call(xl({ op: "append_row", row: ["y"] }));
    expect((res.data as { row: number }).row).toBe(2);
  });

  it("read несуществующего файла НЕ создаёт файл и отдаёт пустую книгу (как Workbooks.Add без сохранения)", async () => {
    const r = rig();
    expect(values(await r.call(xl({})))).toEqual([[""]]);
    expect(r.core.fs.files.size).toBe(0);
    expect(r.kinds("office.excel")[0]).toMatchObject({ op: "read", existed: false });
  });

  it("листы: запись в именованный лист создаёт его, чтение другого листа его не видит", async () => {
    const r = rig();
    await r.call(xl({ op: "write_cell", cell: "A1", value: "s2", sheet: "Итоги" }));
    expect(values(await r.call(xl({ sheet: "Итоги" })))).toEqual([["s2"]]);
    expect(values(await r.call(xl({})))).toEqual([[""]]);
  });

  it("файл не книги (текст в .xlsx) — ошибка открытия, содержимое не затёрто", async () => {
    const r = rig({ files: { "Documents/book.xlsx": "просто текст" } });
    const res = await r.call(xl({ op: "write_cell", cell: "A1", value: "x" }));
    expect(res.ok).toBe(false);
    expect(errOf(res)).toContain("не является книгой Excel");
    expect(r.core.snapshot().files["C:/Users/lab/Documents/book.xlsx"]).toBe("просто текст");
  });

  it("секретный путь: чтение и запись отказаны рельсами §0, эффектов нет", async () => {
    const r = rig({ files: { ".env": "KEY=1" } });
    expect(errOf(await r.call(xl({ path: ".env" })))).toContain("защита секретов");
    expect(errOf(await r.call(xl({ op: "write_cell", path: ".env", cell: "A1", value: "x" })))).toContain("защита секретов");
    expect(r.core.effects).toHaveLength(0);
  });

  it("каталога для сохранения нет — честная ошибка, файл не создан", async () => {
    const r = rig();
    const res = await r.call(xl({ op: "write_cell", path: "NoSuchDir/b.xlsx", cell: "A1", value: "x" }));
    expect(res.ok).toBe(false);
    expect(errOf(res)).toContain("каталога нет");
    expect(r.core.fs.files.size).toBe(0);
  });

  it("Excel не установлен — «Office не установлен»; неверные ячейка/диапазон отвергаются", async () => {
    expect(errOf(await rig({ installedApps: ["notepad"] }).call(xl({})))).toContain("Office не установлен");
    const r = rig();
    expect(errOf(await r.call(xl({ op: "write_cell", cell: "ZZZZ9", value: "x" })))).toContain("неверная ячейка");
    expect(errOf(await r.call(xl({ range: "A1:??" })))).toContain("неверный диапазон");
    expect(errOf(await r.call(xl({ range: "A1:ZZ99999" })))).toContain("читай окнами");
  });
});

describe("office.word", () => {
  it("write/append/read: текст с меткой абзаца в конце, как Content.Text", async () => {
    const r = rig();
    expect((await r.call(wd({ op: "write", text: "Заголовок" }))).ok).toBe(true);
    await r.call(wd({ op: "append", text: "Абзац 2" }));
    const read = await r.call(wd({}));
    expect(read.data).toEqual({ ok: true, op: "read", text: "Заголовок\rАбзац 2\r" });
    expect(readOfficeDoc(r.core, "Documents/doc.docx")).toEqual({ kind: "docx", text: "Заголовок\rАбзац 2" });
  });

  it("write заменяет содержимое; чужой формат по тому же пути — ошибка открытия", async () => {
    const r = rig();
    await r.call(xl({ op: "write_cell", path: "Documents/x.docx", cell: "A1", value: "1" }));
    expect(errOf(await r.call(wd({ path: "Documents/x.docx" })))).toContain("не является документом Word");
    await r.call(wd({ op: "write", text: "один" }));
    await r.call(wd({ op: "write", text: "два" }));
    expect((await r.call(wd({}))).data).toMatchObject({ text: "два\r" });
  });

  it("секретный путь и отсутствие Word — отказ", async () => {
    const r = rig({ files: { "Documents/.env": "K=1" } });
    expect(errOf(await r.call(wd({ op: "write", path: "Documents/.env", text: "x" })))).toContain("защита");
    expect(errOf(await rig({ installedApps: [] }).call(wd({})))).toContain("Office не установлен");
  });
});
