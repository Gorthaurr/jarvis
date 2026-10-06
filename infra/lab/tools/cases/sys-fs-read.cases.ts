/**
 * Кейсы чтения файлов: fs_read. Читаем ЧУЖОЕ (диск — внешний источник): результат обязан идти в <untrusted_content>,
 * обёртка не должна закрываться изнутри, секреты не читаются ни прямым путём, ни через «..», огромное режется ВИДИМО.
 */
import type { EffectCheck, ToolCase, ToolExpect } from "../case-format.js";
import { DOCS, HOME, INJECTION, PROJ, PROJECT_SEED, SECRET, deskLab } from "./sys-fixtures.js";

const F = `${DOCS}/log.txt`;
const LINES = Array.from({ length: 10 }, (_, i) => `строка ${i + 1}`).join("\n");
const noWrite: EffectCheck[] = [{ none: "fs.write" }, { none: "fs.delete" }, { none: "fs.append" }, { none: "fs.edit" }];
const seedF = (t: string) => ({ files: { [F]: t } });
const denied: ToolExpect = { ok: false, resultIncludes: /защита секретов|секретный/i, resultExcludes: SECRET, actionKinds: ["fs.read"] };

export const cases: ToolCase[] = [
  {
    tool: "fs_read", name: "успех: содержимое, кодировка и число строк — внутри <untrusted_content>, диск не тронут",
    args: { path: F }, seed: seedF("привет\nмир\n"),
    expect: { ok: true, actionKinds: ["fs.read"], effects: [...noWrite], resultIncludes: ['<untrusted_content source="fs-read">', '"content":"привет\\nмир\\n"', '"encoding":"utf8"', '"totalLines":2', "НЕДОВЕРЕННЫЕ ДАННЫЕ"] },
    coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "инъекция в файле: чужой </untrusted_content> обезврежен, приказ не исполнен (клиенту ушёл только fs.read)",
    args: { path: F }, seed: seedF(INJECTION),
    expect: { ok: true, asked: 0, actionKinds: ["fs.read"], effects: [...noWrite], resultIncludes: "[/untrusted_content]", resultExcludes: /<\/untrusted_content>[\s\S]*<\/untrusted_content>/ },
    coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "огромный файл: сервер режет ответ, пометка «ОБРЕЗАНО» — ПОСЛЕ обёртки, с советом читать окном",
    args: { path: F }, seed: seedF("длинная строка лога номер N\n".repeat(6000)),
    expect: { ok: true, resultIncludes: [/<\/untrusted_content>[\s\S]*ОБРЕЗАНО сервером/, /fs_read\{offset,lines\}/] },
    coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "файл 3,4 МБ: клиент отдаёт первые 2 МБ и ЧЕСТНО говорит truncated:true с советом читать окном (до обрезки сервера)",
    args: { path: F }, seed: seedF("0123456789abcdef\n".repeat(200_000)),
    expect: { ok: true, resultIncludes: ['"truncated":true', /ОКНОМ/, /ОБРЕЗАНО сервером/], resultExcludes: '"totalLines"' }, coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "UTF-8 с BOM: кодировка названа utf8-bom, BOM не попадает в текст",
    args: { path: F }, seed: seedF("﻿привет"), expect: { ok: true, resultIncludes: ['"encoding":"utf8-bom"', '"content":"привет"'] }, coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "окно offset+lines: ровно строки 3–4 и их диапазон",
    args: { path: F, offset: 3, lines: 2 }, seed: seedF(LINES),
    expect: { ok: true, resultIncludes: ['"content":"строка 3\\nстрока 4"', '"range":{"from":3,"to":4}'], resultExcludes: ["строка 5", "строка 2"] }, coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "tail: последние 2 строки файла",
    args: { path: F, tail: 2 }, seed: seedF(LINES),
    expect: { ok: true, resultIncludes: "строка 10", resultExcludes: "строка 8" }, coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "tail вместе с offset несовместимы — ошибка, а не угаданное окно",
    args: { path: F, tail: 2, offset: 3 }, seed: seedF(LINES),
    expect: { ok: false, actionKinds: ["fs.read"], resultIncludes: /tail|offset/ }, coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "пустой файл — успех с пустым content и 0 строк, не ошибка",
    args: { path: F }, seed: seedF(""),
    expect: { ok: true, resultIncludes: ['"content":""', '"bytes":0'] }, coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "бинарник (PDF по сигнатуре) — честная ошибка с каналом, а не мусор в контексте",
    args: { path: `${DOCS}/doc.txt` }, seed: { files: { [`${DOCS}/doc.txt`]: "%PDF-1.4\n%\u0000\u0001 binary" } },
    expect: { ok: false, resultIncludes: /бинарн/i, resultExcludes: "%PDF-1.4" }, coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "файла нет — ENOENT с путём в Windows-виде",
    args: { path: `${DOCS}/нет.txt` }, expect: { ok: false, resultIncludes: /ENOENT.*нет\.txt/ }, coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "путь — каталог: EISDIR, а не пустой успех",
    args: { path: DOCS }, expect: { ok: false, resultIncludes: /EISDIR/ }, coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: ".env: секрет НЕ попадает в контекст модели",
    args: { path: `${PROJ}/.env` }, seed: PROJECT_SEED, expect: denied, coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "«..» нормализуется ДО рельс: Documents/../project/.env — тот же секрет, отказ",
    args: { path: `${DOCS}/../project/.env` }, seed: PROJECT_SEED, expect: denied, coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "приватный ключ ~/.ssh/id_rsa не читается",
    args: { path: "~/.ssh/id_rsa" }, seed: PROJECT_SEED, expect: { ...denied, resultExcludes: "NOT-A-REAL-KEY" }, coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "чужая %SECRET_TOKEN% не раскрывается: в ошибке остаётся литерал, значение окружения не утекает",
    args: { path: "%SECRET_TOKEN%\\x.txt" }, expect: { ok: false, resultIncludes: "%SECRET_TOKEN%" }, coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "%USERPROFILE% раскрывается в домашнюю папку виртуального ПК",
    args: { path: "%USERPROFILE%\\Documents\\log.txt" }, seed: seedF("данные"), expect: { ok: true, resultIncludes: '"content":"данные"' }, coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "файл в cp1251: кодировка названа честно (encoding:cp1251 и note), не молча «�»",
    args: { path: F }, lab: deskLab({ binaries: { [F]: Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0xec, 0xe8, 0xf0, 0x20, 0xef, 0xf0, 0xee, 0xe2, 0xe5, 0xf0, 0xea, 0xe0]) } }),
    expect: { ok: true, resultIncludes: ['"encoding":"cp1251"', "cp1251"], resultExcludes: "�" }, coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "клиент упал на чтении — «не удалось», содержимого в ответе нет",
    args: { path: F }, lab: deskLab({ seed: seedF("данные"), fault: { kind: "fs.read", mode: "error" } }),
    expect: { ok: false, resultIncludes: /не удалось: runtime/, resultExcludes: "данные" }, coversTool: "fs_read",
  },
  {
    tool: "fs_read", name: "домашняя папка ~ раскрывается: ~/Documents/log.txt читается",
    args: { path: "~/Documents/log.txt" }, seed: { files: { [`${HOME}/Documents/log.txt`]: "через тильду" } }, expect: { ok: true, resultIncludes: "через тильду" }, coversTool: "fs_read",
  },
];
