/**
 * Кейсы записи в ФС: fs_write, fs_append, fs_edit, fs_mkdir. Правило: ФАКТ — содержимое «диска» и эффект, а не «ok:true»;
 * отказ (рельсы самосохранности, нет каталога, плохое имя) обязан оставить «диск» нетронутым и не породить эффекта записи.
 */
import type { ToolCase, ToolExpect } from "../case-format.js";
import { DOCS, PROJ, PROJECT_SEED, SECRET, allOf, deskLab, fileGone, fileIs } from "./sys-fixtures.js";

const NOTE = `${DOCS}/note.txt`;
const TEXT = "купить хлеб\nи молоко 🥛";
const ENV = `${PROJ}/.env`;
const untouched = allOf(fileIs(ENV, `API_KEY=${SECRET}`), fileGone(`${PROJ}/.env.bak`));
const refusedKeepingEnv: ToolExpect = { ok: false, resultIncludes: /самосохранности|защита/i, effects: [{ none: "fs.write" }, { none: "fs.append" }, { none: "fs.edit" }], state: untouched };

export const cases: ToolCase[] = [
  // ───────────── fs_write ─────────────
  {
    tool: "fs_write", name: "новый файл: байты на «диске» точь-в-точь, эффект created:true, вопросов владельцу нет",
    args: { path: NOTE, content: TEXT },
    expect: { ok: true, asked: 0, actionKinds: ["fs.write"], effects: [{ has: "fs.write", detail: { path: NOTE, bytes: Buffer.byteLength(TEXT), created: true } }], state: fileIs(NOTE, TEXT), resultIncludes: '"created":true' },
    coversTool: "fs_write",
  },
  {
    tool: "fs_write", name: "перезапись: старое содержимое потеряно, created:false",
    args: { path: NOTE, content: "новое" }, seed: { files: { [NOTE]: "старое, длинное содержимое" } },
    expect: { ok: true, effects: [{ has: "fs.write", detail: { created: false } }], state: fileIs(NOTE, "новое") },
    coversTool: "fs_write",
  },
  {
    tool: "fs_write", name: "createDirs:true создаёт недостающие каталоги и кладёт файл",
    args: { path: `${DOCS}/a/b/c.txt`, content: "x", createDirs: true },
    expect: { ok: true, effects: [{ has: "fs.write", detail: { created: true } }], state: fileIs(`${DOCS}/a/b/c.txt`, "x") },
    coversTool: "fs_write",
  },
  {
    tool: "fs_write", name: "нет родителя и createDirs не задан — честная ENOENT, ничего не создано",
    args: { path: `${DOCS}/нет/такого/c.txt`, content: "x" },
    expect: { ok: false, resultIncludes: /ENOENT/, effects: [{ none: "fs.write" }], state: fileGone(`${DOCS}/нет/такого/c.txt`) },
    coversTool: "fs_write",
  },
  {
    tool: "fs_write", name: "запрещённый символ в имени (Windows) — ошибка, файла нет",
    args: { path: `${DOCS}/a?b.txt`, content: "x" },
    expect: { ok: false, effects: [{ none: "fs.write" }], state: fileGone(`${DOCS}/a?b.txt`) },
    coversTool: "fs_write",
  },
  {
    tool: "fs_write", name: "путь — каталог: EISDIR, а не молчаливый успех",
    args: { path: DOCS, content: "x" },
    expect: { ok: false, resultIncludes: /EISDIR/, effects: [{ none: "fs.write" }] },
    coversTool: "fs_write",
  },
  {
    tool: "fs_write", name: ".env защищён: перезапись секретов отклонена, файл цел",
    args: { path: ENV, content: "API_KEY=подменено" }, seed: PROJECT_SEED,
    expect: refusedKeepingEnv, coversTool: "fs_write",
  },
  {
    tool: "fs_write", name: "«..» нормализуется ДО рельс: Documents/../project/.env — тот же защищённый .env",
    args: { path: `${DOCS}/../project/.env`, content: "API_KEY=подменено" }, seed: PROJECT_SEED,
    expect: refusedKeepingEnv, coversTool: "fs_write",
  },
  {
    tool: "fs_write", name: "запись в node_modules отклонена (зависимости не правим)",
    args: { path: `${PROJ}/node_modules/dep/index.js`, content: "evil()" }, seed: PROJECT_SEED,
    expect: { ok: false, resultIncludes: /node_modules|самосохранности/, state: fileIs(`${PROJ}/node_modules/dep/index.js`, "module.exports = 1;\n") },
    coversTool: "fs_write",
  },
  {
    tool: "fs_write", name: "%USERPROFILE% раскрывается в домашнюю папку виртуального «ПК»",
    args: { path: "%USERPROFILE%\\Documents\\env.txt", content: "ok" },
    expect: { ok: true, state: fileIs(`${DOCS}/env.txt`, "ok"), resultIncludes: "Documents" },
    coversTool: "fs_write",
  },
  {
    tool: "fs_write", name: "клиент упал на записи — «не удалось» с причиной, файла нет",
    args: { path: NOTE, content: "x" }, lab: deskLab({ fault: { kind: "fs.write", mode: "error" } }),
    expect: { ok: false, resultIncludes: /не удалось: runtime/, state: fileGone(NOTE) },
    coversTool: "fs_write",
  },

  // ───────────── fs_append ─────────────
  {
    tool: "fs_append", name: "дописано в конец: итоговые байты = старое + новое, эффект с totalBytes",
    args: { path: NOTE, content: "вторая" }, seed: { files: { [NOTE]: "первая\n" } },
    expect: { ok: true, actionKinds: ["fs.append"], effects: [{ has: "fs.append", detail: { bytes: Buffer.byteLength("вторая"), totalBytes: Buffer.byteLength("первая\nвторая") } }], state: fileIs(NOTE, "первая\nвторая") },
    coversTool: "fs_append",
  },
  {
    tool: "fs_append", name: "файла нет — создаётся (как обещает схема)",
    args: { path: NOTE, content: "с нуля" },
    expect: { ok: true, state: fileIs(NOTE, "с нуля") }, coversTool: "fs_append",
  },
  {
    tool: "fs_append", name: "путь — каталог: EISDIR, содержимого не появилось",
    args: { path: DOCS, content: "x" },
    expect: { ok: false, resultIncludes: /EISDIR/, effects: [{ none: "fs.append" }] }, coversTool: "fs_append",
  },
  {
    tool: "fs_append", name: "нет родительского каталога — ENOENT, файл не создан",
    args: { path: `${DOCS}/нет/log.txt`, content: "x" },
    expect: { ok: false, resultIncludes: /ENOENT/, state: fileGone(`${DOCS}/нет/log.txt`) }, coversTool: "fs_append",
  },
  {
    tool: "fs_append", name: ".env защищён от дописывания (нельзя подсунуть переменную)",
    args: { path: ENV, content: "\nEVIL=1" }, seed: PROJECT_SEED, expect: refusedKeepingEnv, coversTool: "fs_append",
  },
  {
    tool: "fs_append", name: "клиент выполнил дописывание, но ответ потерян (таймаут) — сервер не должен выдавать это за «не удалось»",
    args: { path: NOTE, content: "строка" }, seed: { files: { [NOTE]: "было\n" } },
    lab: deskLab({ seed: { files: { [NOTE]: "было\n" } }, fault: { kind: "fs.append", mode: "silent_after_effect" } }),
    skip: "ДЕФЕКТ: dispatch.ts:863-873 — timeout мутирующего действия отдаётся как «не удалось» без uncertain; повтор модели допишет строку дважды",
    expect: { flags: { uncertain: true }, state: fileIs(NOTE, "было\nстрока") }, coversTool: "fs_append",
  },
];
