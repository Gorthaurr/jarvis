import { describe, expect, it } from "vitest";
import { EXCEL_SCRIPT, WORD_SCRIPT, buildExcelArgs, buildWordArgs } from "./office.js";

describe("office actuator (§6) — COM-скрипты и аргументы", () => {
  it("Excel-скрипт драйвит COM и читает аргументы из env-JSON (не из тела)", () => {
    expect(EXCEL_SCRIPT).toContain("New-Object -ComObject Excel.Application");
    expect(EXCEL_SCRIPT).toContain("$env:JARVIS_OFFICE_ARGS");
    expect(EXCEL_SCRIPT).toContain("ConvertFrom-Json");
    expect(EXCEL_SCRIPT).toContain("JARVIS_OFFICE_RESULT");
    // headless + очистка COM + все три op
    expect(EXCEL_SCRIPT).toContain("$excel.Visible=$false");
    expect(EXCEL_SCRIPT).toContain("ReleaseComObject");
    expect(EXCEL_SCRIPT).toContain("'read'");
    expect(EXCEL_SCRIPT).toContain("'write_cell'");
    expect(EXCEL_SCRIPT).toContain("'append_row'");
  });

  it("Word-скрипт драйвит COM и читает аргументы из env-JSON", () => {
    expect(WORD_SCRIPT).toContain("New-Object -ComObject Word.Application");
    expect(WORD_SCRIPT).toContain("$env:JARVIS_OFFICE_ARGS");
    expect(WORD_SCRIPT).toContain("JARVIS_OFFICE_RESULT");
    expect(WORD_SCRIPT).toContain("ReleaseComObject");
  });

  it("анти-инъекция: данные не интерполируются в тело скрипта", () => {
    // Скрипты — константы: значения пользователя физически не могут попасть в код,
    // поскольку buildExcelArgs/buildWordArgs кладут их в args (→ temp-JSON), а не в скрипт.
    const evil = "'; Remove-Item C:\\ -Recurse; '";
    const args = buildExcelArgs({ kind: "office.excel", op: "write_cell", path: "x.xlsx", cell: "A1", value: evil });
    expect(args.value).toBe(evil);
    expect(EXCEL_SCRIPT).not.toContain("Remove-Item");
  });

  it("buildExcelArgs нормализует поля и путь", () => {
    const a = buildExcelArgs({ kind: "office.excel", op: "append_row", path: "report.xlsx", row: ["a", "b"] });
    expect(a.op).toBe("append_row");
    expect(a.row).toEqual(["a", "b"]);
    expect(typeof a.path).toBe("string");
    expect(a.cell).toBeNull();
  });

  it("buildWordArgs прокидывает текст и op", () => {
    const a = buildWordArgs({ kind: "office.word", op: "append", path: "doc.docx", text: "привет" });
    expect(a.op).toBe("append");
    expect(a.text).toBe("привет");
  });
});
