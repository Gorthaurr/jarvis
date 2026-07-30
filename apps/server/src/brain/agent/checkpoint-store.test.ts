/**
 * Волна C: durable-стор чекпойнтов — переживает рестарт, протухает по TTL, одноразовый на «продолжи».
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskCheckpoint } from "./checkpoint.js";
import { CheckpointStore, checkpointTtlMs, readCheckpoints, writeCheckpoints } from "./checkpoint-store.js";

let dir = "";
const ENV_KEYS = ["JARVIS_CHECKPOINT_TTL_MS", "JARVIS_TASK_CHECKPOINT"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-cp-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

function cp(over: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
  return {
    userId: "u1",
    taskId: "t1",
    goal: "собери отчёт",
    title: "Отчёт",
    reason: "timeout",
    round: 5,
    savedAt: 1000,
    tier: "sonnet",
    digest: "Вызвал web_fetch() — ok",
    ...over,
  };
}

describe("CheckpointStore", () => {
  it("сохраняет и отдаёт чекпойнт пользователя", () => {
    const store = new CheckpointStore(dir, () => 1000);
    expect(store.save(cp())).toBe(true);
    expect(store.peek("u1")?.goal).toBe("собери отчёт");
    expect(store.peek("u2")).toBeNull();
  });

  it("ПЕРЕЖИВАЕТ рестарт процесса (диск-персист)", () => {
    new CheckpointStore(dir, () => 1000).save(cp());
    const reborn = new CheckpointStore(dir, () => 1000);
    expect(reborn.peek("u1")?.taskId).toBe("t1");
  });

  it("take одноразов: второй «продолжи» старый журнал не поднимает", () => {
    const store = new CheckpointStore(dir, () => 1000);
    store.save(cp());
    expect(store.take("u1")?.round).toBe(5);
    expect(store.take("u1")).toBeNull();
    expect(new CheckpointStore(dir, () => 1000).peek("u1")).toBeNull(); // удаление тоже на диске
  });

  it("протухший по TTL не отдаётся и вычищается", () => {
    process.env.JARVIS_CHECKPOINT_TTL_MS = "60000";
    let now = 1000;
    const store = new CheckpointStore(dir, () => now);
    store.save(cp({ savedAt: now }));
    now += 59_000;
    expect(store.peek("u1")).not.toBeNull();
    now += 2_000;
    expect(store.peek("u1")).toBeNull();
    expect(new CheckpointStore(dir, () => now).peek("u1")).toBeNull();
  });

  it("одна запись на пользователя: новый обрыв перетирает старый", () => {
    const store = new CheckpointStore(dir, () => 1000);
    store.save(cp({ taskId: "t1", goal: "первая" }));
    store.save(cp({ taskId: "t2", goal: "вторая" }));
    expect(store.peek("u1")?.goal).toBe("вторая");
    expect(readCheckpoints(dir)?.items.length).toBe(1);
  });

  it("разные пользователи не мешают друг другу", () => {
    const store = new CheckpointStore(dir, () => 1000);
    store.save(cp({ userId: "u1", goal: "первого" }));
    store.save(cp({ userId: "u2", goal: "второго" }));
    expect(store.take("u1")?.goal).toBe("первого");
    expect(store.peek("u2")?.goal).toBe("второго");
  });

  it("clear снимает чекпойнт (задача доведена — продолжать нечего)", () => {
    const store = new CheckpointStore(dir, () => 1000);
    store.save(cp());
    store.clear("u1");
    expect(store.peek("u1")).toBeNull();
  });

  it("выключатель JARVIS_TASK_CHECKPOINT=0 глушит и запись, и чтение", () => {
    const store = new CheckpointStore(dir, () => 1000);
    store.save(cp());
    process.env.JARVIS_TASK_CHECKPOINT = "0";
    expect(store.peek("u1")).toBeNull();
    expect(store.save(cp({ taskId: "t9" }))).toBe(false);
  });

  it("битый файл на диске не роняет стор (честная деградация)", () => {
    writeFileSync(join(dir, "checkpoints.json"), "{это не json", "utf8");
    const store = new CheckpointStore(dir, () => 1000);
    expect(store.peek("u1")).toBeNull();
    expect(store.save(cp())).toBe(true);
    expect(store.peek("u1")).not.toBeNull();
  });

  it("запись атомарна: на диске валидный JSON, .tmp не остаётся", () => {
    const store = new CheckpointStore(dir, () => 1000);
    store.save(cp());
    const raw = readFileSync(join(dir, "checkpoints.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(() => readFileSync(join(dir, "checkpoints.json.tmp"), "utf8")).toThrow();
  });

  it("протухшие записи ВЫЧИЩАЮТСЯ с диска (выжимки страниц не лежат дольше нужного)", () => {
    process.env.JARVIS_CHECKPOINT_TTL_MS = "60000";
    let now = 1000;
    const store = new CheckpointStore(dir, () => now);
    store.save(cp({ userId: "u1", savedAt: now }));
    now += 120_000;
    store.save(cp({ userId: "u2", savedAt: now }));
    const onDisk = readCheckpoints(dir)?.items ?? [];
    expect(onDisk.map((c) => c.userId)).toEqual(["u2"]); // протухший u1 не остался на диске
  });

  it("на старте протухшее с диска не поднимается и вычищается", () => {
    process.env.JARVIS_CHECKPOINT_TTL_MS = "60000";
    writeCheckpoints(dir, [cp({ userId: "u1", savedAt: 1000 })], 1000);
    const store = new CheckpointStore(dir, () => 1000 + 120_000);
    expect(store.peek("u1")).toBeNull();
    expect(readCheckpoints(dir)?.items ?? []).toHaveLength(0);
  });

  // 🔴 Контрольное ревью-2: обновление журнала «омолаживало» чекпойнт — отменённая владельцем работа
  // жила ещё полные 30 минут. TTL — срок годности НАБЛЮДЕНИЙ, а не отметка последней записи.
  it("refreshJournal обновляет журнал, но НЕ продлевает TTL и не переигрывает предложение", () => {
    let now = 1000;
    const store = new CheckpointStore(dir, () => now);
    store.save(cp({ savedAt: now }));
    store.markOffered("u1", "t1");
    const offeredAt = store.peek("u1")?.offeredAt;
    now += 5 * 60_000;
    store.refreshJournal("u1", "t1", "новый журнал", 9);
    const after = store.peek("u1");
    expect(after?.digest).toBe("новый журнал");
    expect(after?.round).toBe(9);
    expect(after?.savedAt).toBe(1000); // TTL не сдвинут
    expect(after?.offeredAt).toBe(offeredAt); // предложение не переигрывали
  });

  // 🔴 Контрольное ревью-3: peek отдавал ЖИВУЮ ссылку, refreshJournal мутировал её через алиас
  // `opts.resumeFrom`, и saveCheckpoint мержил уже смерженный журнал ВТОРОЙ раз — текущий заход
  // дублировался, первый вытеснялся усечением с ложной причиной «не поместилось».
  it("peek отдаёт КОПИЮ: обновление журнала не мутирует то, что держит вызывающий", () => {
    const store = new CheckpointStore(dir, () => 1000);
    store.save(cp({ digest: "ЗАХОД1" }));
    const held = store.peek("u1");
    store.refreshJournal("u1", "t1", "ЗАХОД1 + ЗАХОД2", 4);
    expect(held?.digest).toBe("ЗАХОД1"); // снимок вызывающего не подменён
    expect(store.peek("u1")?.digest).toBe("ЗАХОД1 + ЗАХОД2");
  });

  it("refreshJournal чужой чекпойнт не трогает", () => {
    const store = new CheckpointStore(dir, () => 1000);
    store.save(cp({ taskId: "mine" }));
    store.refreshJournal("u1", "other", "чужое", 1);
    expect(store.peek("u1")?.digest).toBe("Вызвал web_fetch() — ok");
  });

  it("markOffered ставит окно только своему чекпойнту", () => {
    const store = new CheckpointStore(dir, () => 1000);
    store.save(cp({ taskId: "t1" }));
    store.markOffered("u1", "чужой");
    expect(store.peek("u1")?.offeredAt).toBeUndefined();
    store.markOffered("u1", "t1");
    expect(store.peek("u1")?.offeredAt).toBe(1000);
  });

  it("TTL клампится (кривой env не даёт вечных/мгновенных чекпойнтов)", () => {
    process.env.JARVIS_CHECKPOINT_TTL_MS = "5";
    expect(checkpointTtlMs()).toBe(60_000);
    process.env.JARVIS_CHECKPOINT_TTL_MS = "999999999";
    expect(checkpointTtlMs()).toBe(24 * 60 * 60_000);
    process.env.JARVIS_CHECKPOINT_TTL_MS = "мусор";
    expect(checkpointTtlMs()).toBe(30 * 60_000);
  });
});
