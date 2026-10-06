/**
 * Кейсы точечной правки и каталогов: fs_edit, fs_mkdir. fs_edit при несовпадении обязан вернуть ОШИБКУ (не молчаливый no-op)
 * и не тронуть файл; fs_mkdir идемпотентен, но не превращает файл в каталог.
 */
import type { ToolCase } from "../case-format.js";
import { DOCS, PROJ, PROJECT_SEED, allOf, deskLab, fileGone, fileIs } from "./sys-fixtures.js";

const F = `${DOCS}/code.txt`;
const SRC = "alpha\nbeta\nalpha\ngamma\n";
const seedF = (t: string) => ({ files: { [F]: t } });
const unchanged = (t: string) => allOf(fileIs(F, t));
/** «Привет мир» в cp1251: байты, которые НЕ являются валидным UTF-8. */
const CP1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0xec, 0xe8, 0xf0, 0x20, 0x61, 0x62, 0x63]);

export const cases: ToolCase[] = [
  // ───────────── fs_edit ─────────────
  {
    tool: "fs_edit", name: "уникальный фрагмент заменён, остальной текст цел, replacements:1",
    args: { path: F, old: "beta", new: "БЕТА" }, seed: seedF(SRC),
    expect: { ok: true, actionKinds: ["fs.edit"], effects: [{ has: "fs.edit", detail: { replacements: 1 } }], state: fileIs(F, "alpha\nБЕТА\nalpha\ngamma\n") },
    coversTool: "fs_edit",
  },
  {
    tool: "fs_edit", name: "фрагмента нет — ОШИБКА «не найден», файл не изменён (не молчаливый no-op)",
    args: { path: F, old: "delta", new: "x" }, seed: seedF(SRC),
    expect: { ok: false, resultIncludes: /не найден/, effects: [{ none: "fs.edit" }], state: unchanged(SRC) }, coversTool: "fs_edit",
  },
  {
    tool: "fs_edit", name: "фрагмент встречается дважды без replaceAll — ошибка с числом вхождений, файл цел",
    args: { path: F, old: "alpha", new: "x" }, seed: seedF(SRC),
    expect: { ok: false, resultIncludes: /2 раз/, effects: [{ none: "fs.edit" }], state: unchanged(SRC) }, coversTool: "fs_edit",
  },
  {
    tool: "fs_edit", name: "replaceAll заменяет все вхождения и сообщает их число",
    args: { path: F, old: "alpha", new: "A", replaceAll: true }, seed: seedF(SRC),
    expect: { ok: true, effects: [{ has: "fs.edit", detail: { replacements: 2 } }], state: fileIs(F, "A\nbeta\nA\ngamma\n") }, coversTool: "fs_edit",
  },
  {
    tool: "fs_edit", name: "$&, $1 и $$ в new — буквально, не подстановки регулярки",
    args: { path: F, old: "beta", new: "$& $1 $$" }, seed: seedF(SRC),
    expect: { ok: true, state: fileIs(F, "alpha\n$& $1 $$\nalpha\ngamma\n") }, coversTool: "fs_edit",
  },
  {
    tool: "fs_edit", name: "old == new — «нечего менять», а не успех",
    args: { path: F, old: "beta", new: "beta" }, seed: seedF(SRC),
    expect: { ok: false, resultIncludes: /одинаковы/, state: unchanged(SRC) }, coversTool: "fs_edit",
  },
  {
    tool: "fs_edit", name: "многострочный old с LF в CRLF-файле не совпадает — честная ошибка «не найден» (точное совпадение), файл цел",
    args: { path: F, old: "a\nb", new: "x" }, seed: seedF("a\r\nb\r\n"),
    expect: { ok: false, resultIncludes: /не найден/, state: unchanged("a\r\nb\r\n") }, coversTool: "fs_edit",
  },
  {
    tool: "fs_edit", name: "пустой old — ошибка (иначе вставка «в каждую позицию»)",
    args: { path: F, old: "", new: "x" }, seed: seedF(SRC),
    expect: { ok: false, resultIncludes: /пустой/, state: unchanged(SRC) }, coversTool: "fs_edit",
  },
  {
    tool: "fs_edit", name: "файла нет — ENOENT, ничего не создано",
    args: { path: `${DOCS}/нет.txt`, old: "a", new: "b" },
    expect: { ok: false, resultIncludes: /ENOENT/, state: fileGone(`${DOCS}/нет.txt`) }, coversTool: "fs_edit",
  },
  {
    tool: "fs_edit", name: ".env защищён от правки: секрет не подменить точечно",
    args: { path: `${PROJ}/.env`, old: "sk-live", new: "evil" }, seed: PROJECT_SEED,
    expect: { ok: false, resultIncludes: /самосохранности|защита/i, effects: [{ none: "fs.edit" }], state: fileIs(`${PROJ}/.env`, "API_KEY=sk-live-DO-NOT-LEAK") }, coversTool: "fs_edit",
  },
  {
    tool: "fs_edit", name: "файл не в UTF-8 (cp1251): правка не должна молча превращать чужие байты в «�»",
    args: { path: F, old: "abc", new: "XYZ" }, lab: deskLab({ binaries: { [F]: CP1251 } }),
    skip: "ДЕФЕКТ: apps/client/main/actuators/fs.ts:342 — editFile читает и пишет utf8 без sniff; кириллица в cp1251 портится молча при ok:true",
    expect: { effects: [(fx) => { const e = fx.find((x) => x.kind === "fs.edit"); return !e || e.detail.bytes === CP1251.length || `записано ${String(e.detail.bytes)} байт вместо ${CP1251.length}: чужие байты стали U+FFFD`; }] }, coversTool: "fs_edit",
  },
  {
    tool: "fs_edit", name: "клиент упал на правке — «не удалось», файл не изменён",
    args: { path: F, old: "beta", new: "x" }, lab: deskLab({ seed: seedF(SRC), fault: { kind: "fs.edit", mode: "error" } }),
    expect: { ok: false, resultIncludes: /не удалось: runtime/, state: unchanged(SRC) }, coversTool: "fs_edit",
  },

  // ───────────── fs_mkdir ─────────────
  {
    tool: "fs_mkdir", name: "вложенный каталог создан: эффект created:true, путь в Windows-виде",
    args: { path: `${DOCS}/a/b/c` },
    expect: { ok: true, actionKinds: ["fs.mkdir"], effects: [{ has: "fs.mkdir", detail: { created: true } }], resultIncludes: "Documents\\\\a\\\\b\\\\c" }, coversTool: "fs_mkdir",
  },
  {
    tool: "fs_mkdir", name: "повтор для существующего каталога — успех без нового каталога (created:false)",
    args: { path: `${DOCS}/a` }, before: [{ tool: "fs_mkdir", args: { path: `${DOCS}/a` } }],
    expect: { ok: true, effects: [{ has: "fs.mkdir", detail: { created: false } }] }, coversTool: "fs_mkdir",
  },
  {
    tool: "fs_mkdir", name: "на месте файла — EEXIST, файл не стал каталогом",
    args: { path: F }, seed: seedF("x"),
    expect: { ok: false, resultIncludes: /EEXIST/, effects: [{ none: "fs.mkdir" }], state: fileIs(F, "x") }, coversTool: "fs_mkdir",
  },
  {
    tool: "fs_mkdir", name: "файл посреди пути — ENOTDIR, ничего не создано",
    args: { path: `${F}/sub/dir` }, seed: seedF("x"),
    expect: { ok: false, resultIncludes: /ENOTDIR/, effects: [{ none: "fs.mkdir" }] }, coversTool: "fs_mkdir",
  },
  {
    tool: "fs_mkdir", name: "запрещённый символ в имени — ошибка, каталога нет",
    args: { path: `${DOCS}/a|b` }, expect: { ok: false, effects: [{ none: "fs.mkdir" }] }, coversTool: "fs_mkdir",
  },
  {
    tool: "fs_mkdir", name: "каталог внутри node_modules: рельсы самосохранности обязаны отказать",
    args: { path: `${PROJ}/node_modules/evil` }, seed: PROJECT_SEED,
    skip: "ДЕФЕКТ (low): fs.ts makeDir без assertWritable — карта client-actuators-system.md §5; создание внутри node_modules проходит",
    expect: { ok: false, effects: [{ none: "fs.mkdir" }] }, coversTool: "fs_mkdir",
  },
  {
    tool: "fs_mkdir", name: "клиент упал на mkdir — «не удалось» с причиной",
    args: { path: `${DOCS}/z` }, lab: deskLab({ fault: { kind: "fs.mkdir", mode: "error" } }),
    expect: { ok: false, resultIncludes: /не удалось: runtime/, effects: [{ none: "fs.mkdir" }] }, coversTool: "fs_mkdir",
  },
];
