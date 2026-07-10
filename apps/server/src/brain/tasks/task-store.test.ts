import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskManager } from "./manager.js";
import { flushTaskStores, loadTaskManager, readPersisted, writePersisted } from "./task-store.js";

describe("task-store — реестр переживает рестарт сервера (§5/§20)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-tasks-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("write→read round-trip: терминальные задачи сохраняются и читаются", () => {
    const m = new TaskManager(() => 5_000);
    const done = m.create({ userId: "u1", sessionId: "s1", goal: "отчёт" });
    m.finish(done.taskId, "отчёт готов");

    writePersisted(dir, m.toJSON(), 5_000);
    const snap = readPersisted(dir, 5_100);
    expect(snap).not.toBeNull();
    expect(snap?.tasks).toHaveLength(1);
    expect(snap?.tasks[0]?.resultSummary).toBe("отчёт готов");
    expect(snap?.tasks[0]).not.toHaveProperty("cancel");
  });

  it("loadTaskManager восстанавливает «что сделал» из файла предыдущего процесса", () => {
    // Процесс №1: выполнил задачу и сохранил.
    const first = new TaskManager(() => 5_000);
    const t = first.create({ userId: "u1", sessionId: "s1", goal: "таблица" });
    first.progress(t.taskId, 1); // содержательная (был tool-use) → попадёт в recentTerminal
    first.finish(t.taskId, "таблица на 12 строк");
    writePersisted(dir, first.toJSON(), 5_000);

    // Процесс №2 (рестарт): поднимаем с диска — задача и её итог на месте.
    const second = loadTaskManager(() => 6_000, dir);
    const recalled = second.recentTerminal("u1", { now: 6_000 });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.title).toBe("Таблица");
    expect(recalled[0]?.resultSummary).toBe("таблица на 12 строк");
  });

  it("ЧЕСТНОСТЬ: незавершённая на момент снимка задача после рестарта — failed, не активна", () => {
    const first = new TaskManager(() => 5_000);
    const running = first.create({ userId: "u1", sessionId: "s1", goal: "долгая" });
    first.progress(running.taskId, 1, 4);
    writePersisted(dir, first.toJSON(), 5_000);

    const second = loadTaskManager(() => 6_000, dir);
    expect(second.get(running.taskId)?.state).toBe("failed");
    expect(second.active("s1")).toBeUndefined(); // не «всё ещё делаю»
  });

  it("устаревший снимок (старше TTL) не восстанавливается", () => {
    const m = new TaskManager(() => 0);
    const t = m.create({ userId: "u1", sessionId: "s1", goal: "вчера" });
    m.finish(t.taskId, "x");
    writePersisted(dir, m.toJSON(), 0); // savedAt=0

    const dayMs = 24 * 60 * 60 * 1000;
    expect(readPersisted(dir, dayMs + 1)).toBeNull(); // прошли сутки → не «продолжение»
    const fresh = loadTaskManager(() => dayMs + 1, dir);
    expect(fresh.recentTerminal("u1", { now: dayMs + 1 })).toEqual([]);
  });

  it("нет файла / битый снимок → null, пустой менеджер (без падения)", () => {
    expect(readPersisted(dir, 1_000)).toBeNull();
    const m = loadTaskManager(() => 1_000, dir);
    expect(m.list("u1")).toEqual([]);
    expect(existsSync(join(dir, "tasks.json"))).toBe(false); // загрузка ничего не пишет
  });

  it("onChange после загрузки планирует сохранение (мутация → файл появляется)", async () => {
    const m = loadTaskManager(() => 7_000, dir);
    const t = m.create({ userId: "u1", sessionId: "s1", goal: "новая" });
    m.finish(t.taskId, "сделано");
    // дебаунс 300мс — ждём чуть дольше
    await new Promise((r) => setTimeout(r, 450));
    const snap = readPersisted(dir, Date.now());
    expect(snap?.tasks.some((p) => p.taskId === t.taskId)).toBe(true);
  });

  it("flushTaskStores дописывает отложенный снимок СИНХРОННО (graceful-shutdown гонка)", () => {
    const m = loadTaskManager(() => 8_000, dir);
    const t = m.create({ userId: "u1", sessionId: "s1", goal: "впритык" });
    m.finish(t.taskId, "успел"); // запланировал дебаунс-сохранение (ещё НЕ записано)
    expect(readPersisted(dir, 8_000)).toBeNull(); // таймер не сработал — на диске пусто
    flushTaskStores(); // имитируем gateway.close() перед выходом процесса
    const snap = readPersisted(dir, 8_000);
    expect(snap?.tasks.some((p) => p.taskId === t.taskId)).toBe(true); // задача спасена
    flushTaskStores(); // идемпотентно — второй вызов без падений
  });
});
