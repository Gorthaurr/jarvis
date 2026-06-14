/**
 * Тесты RU-нарратора задач (§20): анонс, вехи, статус, финал, ошибка.
 * Всё детерминированно — без времени/сети/LLM.
 */
import { describe, expect, it } from "vitest";
import {
  announceTask,
  errorReport,
  finalReport,
  milestoneLine,
  shouldAnnounce,
  statusReport,
} from "./narrate.js";
import type { Task } from "./task.js";
import { NARRATE_THRESHOLD_MS } from "./task.js";

/** Фабрика задачи с разумными дефолтами — переопределяем только нужное. */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: "t1",
    userId: "u1",
    sessionId: "s1",
    goal: "сделать таблицу расходов",
    state: "running",
    stepsDone: 0,
    startedAt: 0,
    cancel: { cancelled: false },
    ...overrides,
  };
}

describe("shouldAnnounce", () => {
  it("ниже порога — не анонсируем", () => {
    expect(shouldAnnounce(0)).toBe(false);
    expect(shouldAnnounce(NARRATE_THRESHOLD_MS - 1)).toBe(false);
    expect(shouldAnnounce(4999)).toBe(false);
  });

  it("на пороге и выше — анонсируем", () => {
    expect(shouldAnnounce(NARRATE_THRESHOLD_MS)).toBe(true);
    expect(shouldAnnounce(5000)).toBe(true);
    expect(shouldAnnounce(60_000)).toBe(true);
  });
});

describe("announceTask", () => {
  it("содержит цель", () => {
    const out = announceTask("сделать таблицу расходов");
    expect(out).toContain("сделать таблицу расходов");
  });

  it("чистит markdown из цели для голоса", () => {
    const out = announceTask("сделать **таблицу** расходов");
    expect(out).toContain("сделать таблицу расходов");
    expect(out).not.toContain("**");
  });
});

describe("milestoneLine", () => {
  it("«Шаг N из M» с меткой", () => {
    expect(milestoneLine(1, 3, "открываю файл")).toBe(
      "Шаг 1 из 3: открываю файл",
    );
  });

  it("плюрализация слова «шаг» по номеру", () => {
    expect(milestoneLine(1, 10)).toContain("Шаг 1");
    expect(milestoneLine(2, 10)).toContain("Шага 2");
    expect(milestoneLine(5, 10)).toContain("Шагов 5");
  });

  it("без total — метка с многоточием", () => {
    expect(milestoneLine(0, undefined, "разбираю данные")).toBe(
      "разбираю данные…",
    );
  });

  it("без total и без метки — «Готовлю…»", () => {
    expect(milestoneLine(0)).toBe("Готовлю…");
  });
});

describe("statusReport", () => {
  it("running с прогрессом упоминает цель и шаг", () => {
    const out = statusReport(
      makeTask({ state: "running", stepsDone: 2, stepsTotal: 40 }),
    );
    expect(out).toContain("сделать таблицу расходов");
    expect(out).toContain("2 из 40");
  });

  it("paused-задача упоминает паузу", () => {
    const out = statusReport(makeTask({ state: "paused", stepsDone: 3 }));
    expect(out.toLowerCase()).toContain("паузе");
  });

  it("без stepsTotal сообщает число сделанных шагов", () => {
    const out = statusReport(
      makeTask({ state: "running", stepsDone: 1, stepsTotal: undefined }),
    );
    expect(out).toContain("1 шаг");
  });
});

describe("finalReport", () => {
  it("использует resultSummary, если есть", () => {
    const out = finalReport(makeTask({ resultSummary: "Таблица готова, 12 строк." }));
    expect(out).toContain("Таблица готова");
  });

  it("без summary — короткое «Готово.»", () => {
    expect(finalReport(makeTask({ resultSummary: undefined }))).toBe("Готово.");
  });
});

describe("errorReport", () => {
  it("голос: причина + вопрос-предложение", () => {
    const out = errorReport(
      makeTask({ state: "failed", lastError: "ENOENT: файл не найден" }),
    );
    expect(out.voice).toContain("не вышло");
    expect(out.voice).toContain("?");
  });

  it("display.markdown содержит lastError", () => {
    const out = errorReport(
      makeTask({ state: "failed", lastError: "ENOENT: файл не найден" }),
    );
    expect(out.display?.markdown).toContain("ENOENT: файл не найден");
  });

  it("без lastError — только голос, без display", () => {
    const out = errorReport(makeTask({ state: "failed", lastError: undefined }));
    expect(out.voice).toContain("не вышло");
    expect(out.display).toBeUndefined();
  });
});
