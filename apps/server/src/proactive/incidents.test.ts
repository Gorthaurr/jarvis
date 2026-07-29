/**
 * Голосовой доклад Джарвиса о собственных сбоях (P0 «умер ночью — никто не узнал»). Главный канал
 * алертов: без ботов/токенов/настройки — ассистент говорит сам. Тестируем ЧЕСТНОСТЬ (о падении
 * узнают), анти-спам (одна сводка, без повторов) и устаревание (вчерашнее не тревожит сегодня).
 */
import { describe, expect, it, vi } from "vitest";

const TMP = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || "/tmp";
  const dir = `${base}/jarvis-incidents-test-${process.pid}-${Date.now()}`;
  process.env.JARVIS_DATA_DIR = dir;
  return dir;
});

import { rmSync } from "node:fs";
import { afterAll } from "vitest";
import { type Incident, formatIncidentReport, recordIncident, takeIncidentReport } from "./incidents.js";

afterAll(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const inc = (ts: string, kind = "crash", text = "сервер падал и был перезапущен автоматически"): Incident => ({ ts, kind, text });

describe("formatIncidentReport — честная короткая сводка", () => {
  it("пусто → null (докладывать нечего, молчим)", () => {
    expect(formatIncidentReport([])).toBeNull();
  });

  it("один инцидент → факт + время + текущее состояние", () => {
    const line = formatIncidentReport([inc("2026-07-28T03:40:00")]);
    expect(line).toContain("падал");
    expect(line).toContain("3:40");
    expect(line).toContain("Сейчас всё работает");
  });

  it("несколько инцидентов → ОДНА сводка с их числом (не спам по одному)", () => {
    const line = formatIncidentReport([inc("2026-07-28T03:40:00"), inc("2026-07-28T04:10:00"), inc("2026-07-28T05:00:00")]);
    expect(line).toContain("3 раза");
    expect(line).toContain("5:00"); // время последнего
    expect((line ?? "").split("Небольшой доклад").length - 1).toBe(1); // ровно одна фраза
  });

  // Адверс-ревью: было всегда «раза» → Джарвис говорил «пять раза», «одиннадцать раза».
  it("русская плюрализация: 2-4 → «раза», 5+/11-14 → «раз»", () => {
    const many = (n: number) => formatIncidentReport(Array.from({ length: n }, (_, i) => inc(`2026-07-28T0${(i % 9) + 1}:00:00`))) ?? "";
    expect(many(2)).toContain("2 раза");
    expect(many(4)).toContain("4 раза");
    expect(many(5)).toContain("5 раз");
    expect(many(11)).toContain("11 раз");
    expect(many(22)).toContain("22 раза");
    expect(many(5)).not.toContain("раза");
  });
});

describe("takeIncidentReport — durable-цикл доклада", () => {
  it("записанный инцидент докладывается ОДИН раз (повторный коннект молчит)", () => {
    recordIncident("crash", "сервер падал и был перезапущен автоматически");
    const first = takeIncidentReport();
    expect(first).not.toBeNull();
    expect(first).toContain("падал");
    expect(takeIncidentReport()).toBeNull(); // маркер сдвинут — второй раз не тревожим
  });

  it("новый инцидент после доклада — докладывается снова", () => {
    expect(takeIncidentReport()).toBeNull(); // чистый старт
    recordIncident("health", "сервер не отвечал и был перезапущен");
    const line = takeIncidentReport();
    expect(line).not.toBeNull();
    expect(line).toContain("Сейчас всё работает");
  });

  it("пустая история → null (никаких «всё хорошо» на ровном месте)", () => {
    expect(takeIncidentReport()).toBeNull();
  });
});
