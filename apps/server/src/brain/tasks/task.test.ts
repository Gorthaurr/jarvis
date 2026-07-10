import { describe, expect, it } from "vitest";
import type { Task } from "./task.js";
import { actionTitle, deriveTaskTitle, formatActiveTasks, formatRecentTasks } from "./task.js";

describe("deriveTaskTitle — краткая суть для чипа (§20)", () => {
  it("короткую цель оставляет как есть, с большой буквы", () => {
    expect(deriveTaskTitle("таблица расходов")).toBe("Таблица расходов");
  });

  it("берёт только первую фразу (до точки/!/?)", () => {
    expect(deriveTaskTitle("Сделай отчёт. Потом отправь его на почту.")).toBe("Сделай отчёт");
  });

  it("срезает ведущие вводные слова", () => {
    expect(deriveTaskTitle("ну давай сделай таблицу")).toBe("Сделай таблицу");
    expect(deriveTaskTitle("пожалуйста, открой браузер")).toBe("Открой браузер");
    expect(deriveTaskTitle("слушай, можешь посчитать смету")).toBe("Посчитать смету");
  });

  it("длинную фразу режет по границе слова с многоточием", () => {
    const long = "сделай подробный реферат про Петра Первого со ссылками и оформлением по госту";
    const title = deriveTaskTitle(long);
    expect(title.length).toBeLessThanOrEqual(49); // 48 + «…»
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("Сделай подробный реферат")).toBe(true);
  });

  it("схлопывает лишние пробелы (перевод строки обрывает фразу)", () => {
    expect(deriveTaskTitle("  сделай   таблицу  \n расходов")).toBe("Сделай таблицу");
  });

  it("пустую/мусорную цель не роняет", () => {
    expect(deriveTaskTitle("")).toBe("");
    expect(deriveTaskTitle("   ")).toBe("");
  });

  it("цель из одних вводных слов — не срезает в ноль (оставляет исходную фразу)", () => {
    // если после среза вводных пусто — возвращаем первую фразу как есть
    const t = deriveTaskTitle("ну давай");
    expect(t.length).toBeGreaterThan(0);
  });
});

describe("actionTitle — чип ПО СМЫСЛУ действия, а не по сырой фразе (§20)", () => {
  it("browser_open → дружелюбное имя сервиса по хосту", () => {
    expect(actionTitle("browser_open", { url: "https://music.yandex.ru/home" })).toBe("Яндекс Музыка");
    expect(actionTitle("browser_open", { url: "music.yandex.ru" })).toBe("Яндекс Музыка");
    expect(actionTitle("browser_open", { url: "https://www.youtube.com/watch?v=x" })).toBe("YouTube");
    // незнакомый хост — без www и без схемы
    expect(actionTitle("browser_open", { url: "https://example.org/page" })).toBe("example.org");
  });

  it("browser_act play/pause → суть, click/scroll → null (не суть задачи)", () => {
    expect(actionTitle("browser_act", { intent: "play" })).toBe("Воспроизведение");
    expect(actionTitle("browser_act", { intent: "pause" })).toBe("Пауза");
    expect(actionTitle("browser_act", { intent: "click", text: "ок" })).toBeNull();
  });

  it("запуск приложения / поиск / файл / Office", () => {
    expect(actionTitle("app_launch", { app: "obs" })).toBe("Запуск: Obs");
    expect(actionTitle("web_search", { query: "погода в Москве" })).toBe("Поиск: погода в Москве");
    expect(actionTitle("fs_write", { path: "C:/Users/a/report.xlsx" })).toBe("Файл: report.xlsx");
    expect(actionTitle("office_excel", {})).toBe("Excel");
  });

  it("вспомогательные инструменты (не суть) → null — заголовок поставит следующий значимый вызов", () => {
    expect(actionTitle("screen_capture", {})).toBeNull();
    expect(actionTitle("browser_read", {})).toBeNull();
    expect(actionTitle("memory_write", { text: "x" })).toBeNull();
    expect(actionTitle("skill_save", {})).toBeNull();
  });
});

describe("formatRecentTasks — блок «сделал?» для контекста (§20)", () => {
  const base = (over: Partial<Task>): Task => ({
    taskId: "t",
    userId: "u1",
    sessionId: "s1",
    goal: "g",
    title: "Задача",
    state: "done",
    stepsDone: 0,
    startedAt: 0,
    cancel: { cancelled: false },
    steer: { pending: [] },
    ...over,
  });

  it("пустой список → пустая строка (блок не добавляется)", () => {
    expect(formatRecentTasks([], 1_000)).toBe("");
  });

  it("done с résumé → ✓ + относительное время + итог; есть заголовок-инструкция", () => {
    const now = 10 * 60_000;
    const out = formatRecentTasks(
      [base({ title: "Таблица расходов", state: "done", resultSummary: "Готово, 12 строк.", finishedAt: now - 6 * 60_000 })],
      now,
    );
    expect(out).toContain("# Недавно выполненные задачи");
    expect(out).toContain("сделал?");
    expect(out).toContain("- ✓ Таблица расходов — 6 мин назад: Готово, 12 строк.");
  });

  it("failed → ✗ «не вышло» + причина; cancelled → ⊘ без детали", () => {
    const now = 1_000_000;
    const out = formatRecentTasks(
      [
        base({ title: "Музыка", state: "failed", lastError: "регион заблокирован", finishedAt: now }),
        base({ title: "Загрузка", state: "cancelled", finishedAt: now }),
      ],
      now,
    );
    expect(out).toContain("- ✗ Музыка — только что: не вышло — регион заблокирован");
    expect(out).toContain("- ⊘ Загрузка — только что");
    expect(out).not.toContain("Загрузка — только что:"); // у отменённой нет детали
  });

  it("относительное время: только что / минуты / часы", () => {
    const now = 5 * 60 * 60_000;
    const out = formatRecentTasks(
      [
        base({ title: "Свежая", finishedAt: now - 30_000 }), // <1 мин
        base({ title: "Минуты", finishedAt: now - 45 * 60_000 }),
        base({ title: "Часы", finishedAt: now - 3 * 60 * 60_000 }),
      ],
      now,
    );
    expect(out).toContain("Свежая — только что");
    expect(out).toContain("Минуты — 45 мин назад");
    expect(out).toContain("Часы — 3 ч назад");
  });

  it("длинный résumé обрезается многоточием (не раздуваем хвост промпта)", () => {
    const out = formatRecentTasks(
      [base({ title: "Реферат", state: "done", resultSummary: "а".repeat(400), finishedAt: 1_000 })],
      1_000,
    );
    const line = out.split("\n").find((l) => l.startsWith("- ✓ Реферат"))!;
    expect(line.length).toBeLessThan(220);
    expect(line.endsWith("…")).toBe(true);
  });

  it("done без résumé → строка без хвостового двоеточия", () => {
    const out = formatRecentTasks([base({ title: "Дело", state: "done", finishedAt: 1_000 })], 1_000);
    expect(out).toContain("- ✓ Дело — только что");
    expect(out).not.toContain("Дело — только что:");
  });
});

describe("formatActiveTasks — «в работе сейчас» для «сделал?» на лету (§20)", () => {
  const base = (over: Partial<Task>): Task => ({
    taskId: "t", userId: "u1", sessionId: "s1", goal: "g", title: "Задача",
    state: "running", stepsDone: 0, startedAt: 0, cancel: { cancelled: false }, steer: { pending: [] }, ...over,
  });

  it("пусто → пустая строка", () => {
    expect(formatActiveTasks([], 1_000)).toBe("");
  });

  it("активную задачу подаёт как «в работе» + инструкция не отрицать", () => {
    const now = 3 * 60_000;
    const out = formatActiveTasks([base({ title: "Смета ремонта", startedAt: now - 60_000, stepsDone: 2, stepsTotal: 5 })], now);
    expect(out).toContain("# Задачи В РАБОТЕ прямо сейчас");
    expect(out).toContain("ещё в работе");
    expect(out).toContain("- ⏳ Смета ремонта — начал 1 мин назад, шаг 2/5");
  });
});
