/**
 * Сценарии «документы и файлы»: блокнот, заметка на рабочем столе, поиск по описанию, перенос, переименование.
 * Цели — словами владельца, без подсказок про инструменты; проверка — по итоговому состоянию виртуального ПК.
 */
import * as k from "../eval/kit/index.js";
import { DESK, DOCS, DOWN, HOME, REAL_BUDGET, call } from "../eval/dsl.js";
import type { EvalScenario } from "../eval/types.js";

const NOTEPAD = { process: /^notepad$/iu };

export const scenarios: EvalScenario[] = [
  {
    id: "notepad-write", title: "Открыть блокнот и написать текст",
    goal: "Открой блокнот и напиши там: купить молоко и хлеб.",
    tags: ["gui", "files"], covers: ["tool:app_launch", "tool:input_type", "action:app.launch", "action:input.type"], brain: "real", budget: REAL_BUDGET,
    check: (c) => k.all(k.windowOpen(c, NOTEPAD), k.windowText(c, NOTEPAD, "купить молоко и хлеб")),
    oracle: [{ calls: [call("app_launch", { app: "notepad" }), call("input_type", { text: "купить молоко и хлеб" })], answer: "Открыл блокнот и написал." }],
  },
  {
    id: "note-file-desktop", title: "Создать файл-заметку на рабочем столе",
    goal: "Создай на рабочем столе файл-заметку «Идеи» с текстом: проверить договор до пятницы.",
    tags: ["files"], covers: ["tool:fs_write", "action:fs.write"], brain: "real", budget: REAL_BUDGET,
    // Дом мозг не знает (клиент лаборатории не шлёт client.env) — ищем «файл Идеи на рабочем столе» по шаблону пути.
    check: (c) => k.fileNear(c, { dir: /(?:^|\/)desktop$/u, name: /^идеи(?:\.\w+)?$/u, text: "проверить договор до пятницы" }),
    oracle: [{ calls: [call("fs_write", { path: `${DESK}/Идеи.txt`, content: "Проверить договор до пятницы." })], answer: "Создал заметку «Идеи» на рабочем столе." }],
  },
  {
    id: "find-file-by-description", title: "Найти файл по описанию",
    goal: "Найди у меня файл про аренду офиса и скажи, где он лежит.",
    tags: ["files", "search"], covers: ["tool:fs_search", "action:fs.search"], brain: "real", budget: REAL_BUDGET,
    seed: {
      files: {
        [`${DOCS}/Договор аренды офиса.txt`]: "Договор аренды офиса на Тверской, срок 12 месяцев, арендодатель ООО Ромашка.",
        [`${DOCS}/Смета на ремонт.txt`]: "Смета: покраска стен, плитка, электрика.",
        [`${DOCS}/Рецепт борща.txt`]: "Свёкла, капуста, мясо.",
        [`${DOWN}/фото с отпуска.txt`]: "Сочи, июль.",
      },
    },
    // Факт — ответ (он и есть результат поиска): правильный файл назван, чужие нет, ничего не изменено.
    check: (c) => k.all(k.answerMentions(c, /договор\S*\s+аренд/iu, "имя файла про аренду"), k.answerMentions(c, /документ|documents/iu, "папка Документы"), k.noFsMutations(c),
      /смет|борщ/iu.test(k.answerOf(c)) ? k.fail("в ответе чужие файлы") : k.pass("чужие файлы не названы")),
    oracle: [{ calls: [call("fs_search", { root: HOME, query: "аренд" })], answer: "Файл «Договор аренды офиса» лежит в папке Документы." }],
  },
  {
    id: "move-file", title: "Перенести файл в другую папку",
    goal: "Перенеси файл «счёт за март» из Загрузок в Документы.",
    tags: ["files"], covers: ["tool:fs_move", "action:fs.move"], brain: "real", budget: REAL_BUDGET,
    seed: { files: { [`${DOWN}/счёт за март.txt`]: "Счёт №42 за март: 15000 руб." } },
    check: (c) => k.fileMoved(c, `${DOWN}/счёт за март.txt`, `${DOCS}/счёт за март.txt`),
    oracle: [{ calls: [call("fs_move", { from: `${DOWN}/счёт за март.txt`, to: `${DOCS}/счёт за март.txt` })], answer: "Перенёс в Документы." }],
  },
  {
    id: "rename-file", title: "Переименовать файл",
    goal: "Переименуй файл «черновик» на рабочем столе в «план».",
    tags: ["files"], covers: ["tool:fs_move", "action:fs.move"], brain: "real", budget: REAL_BUDGET,
    seed: { files: { [`${DESK}/черновик.txt`]: "первая версия плана" } },
    check: (c) => k.all(k.fileNear(c, { dir: /(?:^|\/)desktop$/u, name: /^план(?:\.txt)?$/u, text: "первая версия плана" }), k.fileAbsent(c, `${DESK}/черновик.txt`)),
    oracle: [{ calls: [call("fs_move", { from: `${DESK}/черновик.txt`, to: `${DESK}/план.txt` })], answer: "Переименовал." }],
  },
];
