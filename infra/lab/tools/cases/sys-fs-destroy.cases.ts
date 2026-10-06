/**
 * Кейсы необратимого: fs_delete (§14 — ВСЕ исходы подтверждения: да / нет / истекло / не смогли спросить) и fs_move
 * (без вопроса по политике: перезапись цели видна в эффекте). Отказ владельца/канала обязан оставить «диск» целым.
 */
import type { EffectCheck, ToolCase } from "../case-format.js";
import { DOCS, PROJ, PROJECT_SEED, allOf, deskLab, fileGone, fileIs, yesIf } from "./sys-fixtures.js";

const REP = `${DOCS}/report.txt`;
const one = { files: { [REP]: "квартальный отчёт" } };
const kept = fileIs(REP, "квартальный отчёт");
const tree = { files: { [`${DOCS}/old/a.txt`]: "a", [`${DOCS}/old/deep/b.txt`]: "b" } };
const envKept = fileIs(`${PROJ}/.env`, "API_KEY=sk-live-DO-NOT-LEAK");
const noDelete: EffectCheck[] = [{ none: "fs.delete" }];

export const cases: ToolCase[] = [
  // ───────────── fs_delete: §14 ─────────────
  {
    tool: "fs_delete", name: "«да»: вопрос назвал файл и вид irreversible, файл удалён навсегда (эффект permanent)",
    args: { path: REP }, seed: one, confirm: yesIf(/report\.txt/),
    expect: { ok: true, flags: { declined: false }, asked: 1, actionKinds: ["fs.delete"], effects: [{ has: "fs.delete", detail: { path: REP, type: "file", permanent: true } }], state: fileGone(REP) },
    coversTool: "fs_delete",
  },
  {
    tool: "fs_delete", name: "«нет»: «Отменено пользователем», клиенту ничего не ушло, файл цел",
    args: { path: REP }, seed: one, confirm: "no",
    expect: { ok: true, flags: { declined: true, channelDown: false }, asked: 1, actionKinds: [], resultIncludes: /Отменено пользователем/, effects: noDelete, state: kept },
    coversTool: "fs_delete",
  },
  {
    tool: "fs_delete", name: "окно истекло: «не ответили», отказ НЕ приписан владельцу, канал не помечен мёртвым",
    args: { path: REP }, seed: one, confirm: "expire",
    expect: { flags: { declined: true, channelDown: false }, asked: 1, actionKinds: [], resultIncludes: /не ответили|истекл/, resultExcludes: /Отменено пользователем/, state: kept },
    coversTool: "fs_delete",
  },
  {
    tool: "fs_delete", name: "не смогли спросить: «не смог спросить», отказ не приписан владельцу, channelDown (петле ждать связь)",
    args: { path: REP }, seed: one, confirm: "undelivered",
    expect: { flags: { declined: true, channelDown: true }, asked: 1, actionKinds: [], resultIncludes: /не смог спросить/, resultExcludes: /Отменено пользователем/, state: kept },
    coversTool: "fs_delete",
  },
  {
    tool: "fs_delete", name: "канала подтверждения нет вовсе — fail-closed: не удаляем, ошибка «канал недоступен»",
    args: { path: REP }, seed: one, lab: { ctx: { confirm: undefined } },
    expect: { ok: false, asked: 0, actionKinds: [], resultIncludes: /канал недоступен/, state: kept },
    coversTool: "fs_delete",
  },
  // ───────────── fs_delete: рельсы клиента ПОСЛЕ «да» ─────────────
  {
    tool: "fs_delete", name: "каталог без recursive даже после «да» — ошибка EISDIR, содержимое цело",
    args: { path: `${DOCS}/old` }, seed: tree, confirm: "yes",
    expect: { ok: false, asked: 1, resultIncludes: /EISDIR/, state: allOf(fileIs(`${DOCS}/old/a.txt`, "a"), fileIs(`${DOCS}/old/deep/b.txt`, "b")) },
    coversTool: "fs_delete",
  },
  {
    tool: "fs_delete", name: "recursive:true снёс каталог со всеми вложенными файлами (entries в эффекте)",
    args: { path: `${DOCS}/old`, recursive: true }, seed: tree, confirm: "yes",
    expect: { ok: true, asked: 1, effects: [{ has: "fs.delete", detail: { type: "dir", recursive: true } }], state: allOf(fileGone(`${DOCS}/old/a.txt`), fileGone(`${DOCS}/old/deep/b.txt`)) },
    coversTool: "fs_delete",
  },
  {
    tool: "fs_delete", name: "recursive по проекту с node_modules/.env внутри: «да» не помогает — поддерево защищено, всё цело",
    args: { path: PROJ, recursive: true }, seed: PROJECT_SEED, confirm: "yes",
    expect: { ok: false, asked: 1, actionKinds: ["fs.delete"], resultIncludes: /содержит защищённое/, effects: noDelete, state: envKept },
    coversTool: "fs_delete",
  },
  {
    tool: "fs_delete", name: ".env после «да»: спросили, команда ушла, клиент отказал — секрет цел",
    args: { path: `${PROJ}/.env` }, seed: PROJECT_SEED, confirm: "yes",
    expect: { ok: false, asked: 1, actionKinds: ["fs.delete"], resultIncludes: /самосохранности|защита/i, effects: noDelete, state: envKept },
    coversTool: "fs_delete",
  },
  {
    tool: "fs_delete", name: "«..» нормализуется до рельс: Documents/../project/.env — тот же защищённый файл",
    args: { path: `${DOCS}/../project/.env` }, seed: PROJECT_SEED, confirm: "yes",
    expect: { ok: false, resultIncludes: /самосохранности|защита/i, effects: noDelete, state: envKept }, coversTool: "fs_delete",
  },
  {
    tool: "fs_delete", name: "корень диска C:\\ recursive после «да» — отказ (EPERM), документы целы",
    args: { path: "C:\\", recursive: true }, seed: one, confirm: "yes",
    expect: { ok: false, asked: 1, resultIncludes: /EPERM/, state: kept }, coversTool: "fs_delete",
  },
  {
    tool: "fs_delete", name: "файла нет: спросили, «да», честная ENOENT — не «удалено»",
    args: { path: `${DOCS}/нет.txt` }, confirm: "yes", expect: { ok: false, asked: 1, resultIncludes: /ENOENT/, effects: noDelete }, coversTool: "fs_delete",
  },
  {
    tool: "fs_delete", name: "клиент упал после «да» — «не удалось», файл цел, а не «удалено»",
    args: { path: REP }, confirm: "yes", lab: deskLab({ seed: one, fault: { kind: "fs.delete", mode: "error" } }),
    expect: { ok: false, asked: 1, resultIncludes: /не удалось: runtime/, resultExcludes: /deleted":true/, state: kept }, coversTool: "fs_delete",
  },

  // ───────────── fs_move ─────────────
  {
    tool: "fs_move", name: "переименование: содержимое на новом месте, старого пути нет, вопросов нет",
    args: { from: REP, to: `${DOCS}/отчёт (финал).txt` }, seed: one,
    expect: { ok: true, asked: 0, actionKinds: ["fs.move"], effects: [{ has: "fs.move", detail: { from: REP, replaced: false, type: "file" } }], state: allOf(fileGone(REP), fileIs(`${DOCS}/отчёт (финал).txt`, "квартальный отчёт")) },
    coversTool: "fs_move",
  },
  {
    tool: "fs_move", name: "цель существует — перезаписана (как обещает схема), replaced:true виден в эффекте",
    args: { from: REP, to: `${DOCS}/target.txt` }, seed: { files: { [REP]: "новое", [`${DOCS}/target.txt`]: "старое" } },
    expect: { ok: true, effects: [{ has: "fs.move", detail: { replaced: true } }], state: allOf(fileGone(REP), fileIs(`${DOCS}/target.txt`, "новое")) }, coversTool: "fs_move",
  },
  {
    tool: "fs_move", name: "каталог переезжает вместе с содержимым",
    args: { from: `${DOCS}/old`, to: `${DOCS}/new` }, seed: tree,
    expect: { ok: true, effects: [{ has: "fs.move", detail: { type: "dir" } }], state: allOf(fileGone(`${DOCS}/old/a.txt`), fileIs(`${DOCS}/new/a.txt`, "a"), fileIs(`${DOCS}/new/deep/b.txt`, "b")) }, coversTool: "fs_move",
  },
  {
    tool: "fs_move", name: "источника нет — ENOENT rename, целевой файл не создан",
    args: { from: `${DOCS}/нет.txt`, to: `${DOCS}/x.txt` }, expect: { ok: false, resultIncludes: /ENOENT/, state: fileGone(`${DOCS}/x.txt`) }, coversTool: "fs_move",
  },
  {
    tool: "fs_move", name: "нет каталога назначения — ENOENT, источник на месте",
    args: { from: REP, to: `${DOCS}/нет/x.txt` }, seed: one, expect: { ok: false, resultIncludes: /ENOENT/, state: kept }, coversTool: "fs_move",
  },
  {
    tool: "fs_move", name: "каталог внутрь самого себя — отказ (EPERM), дерево цело",
    args: { from: `${DOCS}/old`, to: `${DOCS}/old/deep/inner` }, seed: tree, expect: { ok: false, resultIncludes: /EPERM|EBUSY/, state: fileIs(`${DOCS}/old/a.txt`, "a") }, coversTool: "fs_move",
  },
  {
    tool: "fs_move", name: "вынести .env из проекта запрещено (иначе обход рельс переименованием)",
    args: { from: `${PROJ}/.env`, to: `${DOCS}/env.txt` }, seed: PROJECT_SEED,
    expect: { ok: false, resultIncludes: /самосохранности|защита/i, state: allOf(envKept, fileGone(`${DOCS}/env.txt`)) }, coversTool: "fs_move",
  },
  {
    tool: "fs_move", name: "каталог с node_modules/.env внутри целиком не двигается (проверка поддерева источника)",
    args: { from: PROJ, to: `${DOCS}/proj` }, seed: PROJECT_SEED,
    expect: { ok: false, resultIncludes: /содержит защищённое/, state: allOf(envKept, fileGone(`${DOCS}/proj/.env`)) }, coversTool: "fs_move",
  },
  {
    tool: "fs_move", name: "поверх .env перемещать нельзя (цель под защитой), источник остаётся",
    args: { from: REP, to: `${PROJ}/.env` }, seed: { files: { ...PROJECT_SEED.files, [REP]: "подмена" } },
    expect: { ok: false, resultIncludes: /самосохранности|защита/i, state: allOf(envKept, fileIs(REP, "подмена")) }, coversTool: "fs_move",
  },
  {
    tool: "fs_move", name: "клиент упал на переносе — «не удалось», файл на старом месте",
    args: { from: REP, to: `${DOCS}/x.txt` }, lab: deskLab({ seed: one, fault: { kind: "fs.move", mode: "error" } }),
    expect: { ok: false, resultIncludes: /не удалось: runtime/, state: allOf(kept, fileGone(`${DOCS}/x.txt`)) }, coversTool: "fs_move",
  },
];
