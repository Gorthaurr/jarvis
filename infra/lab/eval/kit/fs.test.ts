import { describe, expect, it } from "vitest";
import { mkCtx } from "../testkit.js";
import { countFiles, fileAbsent, fileExists, fileHasText, fileIntact, fileMoved, fileNear, noFsMutations } from "./fs.js";
import { all, fail, pass } from "./core.js";

const D = "C:/Users/lab/Documents";

describe("fileHasText / fileExists / fileAbsent", () => {
  const done = mkCtx({ desktop: { files: { [`${D}/План.txt`]: "Купить хлеб и молоко" } }, before: { files: {} } });
  const undone = mkCtx({ desktop: { files: {} } });

  it("зелёный: файл есть и текст найден (регистр, ё/е и слэши не мешают)", () => {
    expect(fileHasText(done, "c:\\users\\lab\\documents\\план.txt", "купить ХЛЕБ").pass).toBe(true);
    expect(fileExists(done, `${D}/План.txt`).pass).toBe(true);
    expect(fileAbsent(undone, `${D}/План.txt`).pass).toBe(true);
  });

  it("красный: цель не достигнута — файла нет / текст другой / файл остался", () => {
    expect(fileHasText(undone, `${D}/План.txt`, "хлеб")).toMatchObject({ pass: false, why: expect.stringContaining("нет в ФС") });
    expect(fileHasText(done, `${D}/План.txt`, "сахар")).toMatchObject({ pass: false, why: expect.stringContaining("Купить хлеб") });
    expect(fileExists(undone, `${D}/План.txt`).pass).toBe(false);
    expect(fileAbsent(done, `${D}/План.txt`).pass).toBe(false);
  });

  it("бинарный файл не считается содержащим текст", () => {
    const bin = mkCtx({ desktop: { files: { [`${D}/a.bin`]: { binary: 9 } } } });
    expect(fileHasText(bin, `${D}/a.bin`, "x").pass).toBe(false);
  });
});

describe("fileIntact", () => {
  const files = { [`${D}/важное.txt`]: "не трогать" };
  it("зелёный: содержимое то же", () => expect(fileIntact(mkCtx({ desktop: { files }, before: { files } }), `${D}/важное.txt`).pass).toBe(true));
  it("красный: файл удалён", () => expect(fileIntact(mkCtx({ desktop: { files: {} }, before: { files } }), `${D}/важное.txt`)).toMatchObject({ pass: false, why: expect.stringContaining("пропал") }));
  it("красный: файл перезаписан", () => expect(fileIntact(mkCtx({ desktop: { files: { [`${D}/важное.txt`]: "испорчено" } }, before: { files } }), `${D}/важное.txt`).pass).toBe(false));
});

describe("fileNear (папка и имя по шаблону — путь дома мозг может не знать)", () => {
  const desk = "C:/Users/lab/Desktop";
  it("зелёный: подходящий файл на рабочем столе с текстом", () => {
    const c = mkCtx({ desktop: { files: { [`${desk}/Идеи.txt`]: "проверить договор до пятницы" } } });
    expect(fileNear(c, { dir: /\/desktop$/u, name: /^идеи(\.\w+)?$/u, text: "проверить договор" }).pass).toBe(true);
  });
  it("красный: файл в другой папке", () => {
    const c = mkCtx({ desktop: { files: { [`${D}/Идеи.txt`]: "проверить договор" } } });
    expect(fileNear(c, { dir: /\/desktop$/u, name: /идеи/u }).pass).toBe(false);
  });
  it("красный: файл есть, текста нет — причина называет содержимое", () => {
    const c = mkCtx({ desktop: { files: { [`${desk}/Идеи.txt`]: "пусто" } } });
    expect(fileNear(c, { dir: /desktop/u, name: /идеи/u, text: "договор" })).toMatchObject({ pass: false, why: expect.stringContaining("пусто") });
  });
});

describe("fileMoved", () => {
  const from = "C:/Users/lab/Downloads/счёт.txt";
  const to = `${D}/счёт.txt`;
  const before = { files: { [from]: "1000 руб" } };
  it("зелёный: по новому пути то же, по старому пусто", () => expect(fileMoved(mkCtx({ desktop: { files: { [to]: "1000 руб" } }, before }), from, to).pass).toBe(true));
  it("красный: копия вместо переноса", () => expect(fileMoved(mkCtx({ desktop: { files: { [to]: "1000 руб", [from]: "1000 руб" } }, before }), from, to)).toMatchObject({ pass: false, why: expect.stringContaining("копия") }));
  it("красный: ничего не сделано / содержимое потеряно", () => {
    expect(fileMoved(mkCtx({ desktop: before, before }), from, to).pass).toBe(false);
    expect(fileMoved(mkCtx({ desktop: { files: { [to]: "" } }, before }), from, to).pass).toBe(false);
  });
});

describe("noFsMutations / countFiles / all", () => {
  it("красный на любой записи, зелёный на чтении", () => {
    const eff = (kind: string) => ({ n: 1, at: 0, kind, detail: {} });
    expect(noFsMutations(mkCtx({ desktop: { effects: [eff("fs.write")] } })).pass).toBe(false);
    expect(noFsMutations(mkCtx({ desktop: { effects: [eff("fs.delete")] } })).pass).toBe(false);
    expect(noFsMutations(mkCtx({ desktop: { effects: [eff("fs.read"), eff("window.focus")] } })).pass).toBe(true);
  });
  it("countFiles считает по имени без учёта регистра", () => expect(countFiles(mkCtx({ desktop: { files: { "C:/a/01_x.txt": "", "C:/a/y.txt": "" } } }).desktop, /\/\d\d_/u)).toBe(1));
  it("all: провал любого — провал, причины только красных", () => {
    expect(all(pass("а"), fail("б"), fail("в"))).toEqual({ pass: false, why: "б; в" });
    expect(all(pass("а"), pass("б"))).toEqual({ pass: true, why: "а; б" });
  });
});
