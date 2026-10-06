import { describe, expect, it } from "vitest";
import { buildTurn, judgeEnd, taskStates } from "./client-turn.js";
import type { LabEvent } from "./recorder.js";

const ev = (at: number, type: string, payload: unknown, dir: "in" | "out" = "in", id?: string): LabEvent => ({ at, dir, type, payload, ...(id ? { id } : {}) });
const st = (at: number, state: string): LabEvent => ev(at, "client.state", { state });
const task = (at: number, taskId: string, state: string): LabEvent => ev(at, "task.status", { taskId, state, title: `T-${taskId}` });

describe("конец хода (judgeEnd)", () => {
  it("одинокий idle без thinking/speaking — не признак конца хода (чужой idle), пока кадры идут", () => {
    expect(judgeEnd([st(0, "idle")], 100, false)).toBeNull();
  });

  it("thinking → idle: ход закончен, без задач и без ожидания", () => {
    expect(judgeEnd([st(0, "thinking"), st(50, "idle")], 60, false)).toBe("idle");
  });

  it("thinking без idle — ход идёт", () => {
    expect(judgeEnd([st(0, "thinking")], 99_999, false)).toBeNull();
  });

  it("управляющая фраза без thinking: ждём тишину 1,5 с после последнего кадра", () => {
    const evs = [ev(0, "chat", { role: "assistant", text: "Слушаю" })];
    expect(judgeEnd(evs, 1_000, false)).toBeNull();
    expect(judgeEnd(evs, 1_600, false)).toBe("idle");
  });

  it("пинги не считаются активностью", () => {
    expect(judgeEnd([ev(0, "ping", {})], 99_999, false)).toBeNull();
  });

  it("waitTasks: пока задача running — не конец; терминал + хвост 0,5 с → task_done", () => {
    const evs = [st(0, "thinking"), task(10, "a", "running"), st(20, "idle")];
    expect(judgeEnd(evs, 5_000, true)).toBeNull();
    const done = [...evs, task(3_000, "a", "done")];
    expect(judgeEnd(done, 3_100, true)).toBeNull(); // хвост под итоговый chat
    expect(judgeEnd(done, 3_600, true)).toBe("task_done");
  });

  it("waitTasks: задач не появилось — idle после короткой паузы (вдруг стартует фон)", () => {
    const evs = [st(0, "thinking"), st(20, "idle")];
    expect(judgeEnd(evs, 100, true)).toBeNull();
    expect(judgeEnd(evs, 500, true)).toBe("idle");
  });

  it("waitTasks: waiting_confirm — не терминал", () => {
    expect(judgeEnd([st(0, "thinking"), task(5, "a", "waiting_confirm"), st(9, "idle")], 99_999, true)).toBeNull();
  });
});

describe("сборка TurnResult", () => {
  const evs: LabEvent[] = [
    ev(1, "chat", { role: "user", text: "включи музыку" }),
    st(2, "thinking"),
    ev(3, "action.command", { kind: "media.control", timeoutMs: 100 }, "in", "c1"),
    ev(9, "action.result", { commandId: "c1", ok: true, durationMs: 5 }, "out"),
    ev(10, "user.confirm.request", { requestId: "q1", summary: "Отправить?", kind: "send" }),
    ev(11, "user.confirm.result", { requestId: "q1", approved: false, outcome: "expired" }, "out"),
    ev(12, "speak.chunk", { seq: 0, last: false, audioBytes: 100, format: "pcm16", sampleRate: 24000 }),
    ev(13, "speak.chunk", { seq: 1, last: true, audioBytes: 50 }),
    ev(14, "ui.display", { title: "Плейлист", markdown: "# ok" }),
    task(15, "t1", "running"),
    task(16, "t1", "done"),
    ev(17, "chat", { role: "assistant", text: "Включил." }),
    ev(18, "error", { code: "internal", message: "сбой" }),
    st(19, "idle"),
  ];
  const t = buildTurn("включи музыку", evs, Date.now() - 5, "idle");

  it("чат, ответ и состояния", () => {
    expect(t.chat.map((c) => c.role)).toEqual(["user", "assistant"]);
    expect(t.answer).toBe("Включил.");
    expect(t.states).toEqual(["thinking", "idle"]);
  });
  it("действие спарено с результатом по commandId, время — разница кадров", () => {
    expect(t.actions).toHaveLength(1);
    expect(t.actions[0]).toMatchObject({ cmd: { kind: "media.control" }, result: { commandId: "c1", ok: true }, ms: 6 });
  });
  it("вопрос §14 показан с ответом, восстановленным из outcome", () => {
    expect(t.confirms).toEqual([{ summary: "Отправить?", kind: "send", answer: "expire" }]);
  });
  it("озвучка: чанки, байты, тип; задача — последнее состояние; карточка", () => {
    expect(t.speech).toEqual({ chunks: 2, bytes: 150, audioMime: "audio/pcm16;rate=24000" });
    expect(t.tasks).toEqual([{ taskId: "t1", state: "done", title: "T-t1" }]);
    expect(t.cards).toEqual([{ title: "Плейлист", markdown: "# ok" }]);
  });
  it("ошибка сервера делает ход неуспешным, таймаут ожидания — тоже", () => {
    expect(t.serverErrors).toEqual(["internal: сбой"]);
    expect(t.ok).toBe(false);
    expect(buildTurn("x", [st(1, "thinking"), st(2, "idle")], Date.now(), "timeout").ok).toBe(false);
    expect(buildTurn("x", [st(1, "thinking"), st(2, "idle")], Date.now(), "idle").ok).toBe(true);
  });
  it("команда без результата не попадает в actions (нечего утверждать)", () => {
    expect(buildTurn("x", [ev(1, "action.command", { kind: "k" }, "in", "z")], Date.now(), "timeout").actions).toEqual([]);
  });
  it("taskStates сохраняет title, если позднее событие его не несёт", () => {
    expect(taskStates([task(1, "a", "running"), ev(2, "task.status", { taskId: "a", state: "done" })])).toEqual([{ taskId: "a", state: "done", title: "T-a" }]);
  });
});
