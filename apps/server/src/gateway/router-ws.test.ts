/**
 * Управление задачами через router (§20): голосовые/UI-команды «стоп»/«отмени»/
 * «пауза»/«продолжи»/«что делаешь». Проверяем ключевое различие §20 (stop_tts vs
 * cancel) и маршрутизацию task.control из UI. SessionContext подменяется минимальным
 * фейком — нужны только session.send, voice.onVadEvent и общий TaskManager.
 */
import { describe, expect, it, vi } from "vitest";
import { TaskManager } from "../brain/tasks/manager.js";
import { type SessionContext } from "./router-ws.js";
import { handleControlUtterance, handleTakeover, handleTaskControl } from "./task-control.js";

interface SentEnvelope {
  type: string;
  payload: Record<string, unknown>;
}

function fakeCtx(tasks: TaskManager) {
  const sent: SentEnvelope[] = [];
  const send = vi.fn((type: string, payload: unknown) => {
    sent.push({ type, payload: payload as Record<string, unknown> });
  });
  const onVadEvent = vi.fn();
  const speakQueued = vi.fn();
  const ctx = {
    session: { sessionId: "s1", userId: "u1", send },
    voice: { onVadEvent, clearPendingSpeech: vi.fn(), speakQueued },
    agentDeps: { tasks },
  } as unknown as SessionContext;
  return { ctx, sent, onVadEvent, speakQueued };
}

describe("router task control (§20)", () => {
  it("«стоп» рубит ТОЛЬКО озвучку (barge_in), задачу не трогает", () => {
    const tasks = new TaskManager();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const { ctx, onVadEvent } = fakeCtx(tasks);

    expect(handleControlUtterance(ctx, "стоп")).toBe(true);
    expect(onVadEvent).toHaveBeenCalledWith("barge_in");
    expect(tasks.get(t.taskId)?.state).toBe("running"); // §20: задача жива
  });

  it("«отмени» отменяет активную задачу (§20)", () => {
    const tasks = new TaskManager();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const { ctx, sent } = fakeCtx(tasks);

    expect(handleControlUtterance(ctx, "отмени")).toBe(true);
    expect(tasks.get(t.taskId)?.state).toBe("cancelled");
    expect(sent.some((e) => e.type === "task.status" && e.payload.state === "cancelled")).toBe(true);
  });

  it("«отмени» снимает ВСЕ параллельные задачи сессии (§20), не только свежую", () => {
    const tasks = new TaskManager();
    const a = tasks.create({ userId: "u1", sessionId: "s1", goal: "первая" });
    const b = tasks.create({ userId: "u1", sessionId: "s1", goal: "вторая" });
    const { ctx, sent } = fakeCtx(tasks);

    expect(handleControlUtterance(ctx, "отмени")).toBe(true);
    expect(tasks.get(a.taskId)?.state).toBe("cancelled"); // старая тоже снята
    expect(tasks.get(b.taskId)?.state).toBe("cancelled");
    // Статус по каждой снятой задаче ушёл в UI.
    const cancelledStatuses = sent.filter((e) => e.type === "task.status" && e.payload.state === "cancelled");
    expect(cancelledStatuses).toHaveLength(2);
  });

  it("«что делаешь» при активной задаче → отчёт статуса (перехвачено)", () => {
    const tasks = new TaskManager();
    tasks.create({ userId: "u1", sessionId: "s1", goal: "таблица расходов" });
    const { ctx, sent } = fakeCtx(tasks);

    expect(handleControlUtterance(ctx, "что делаешь")).toBe(true);
    const transcript = sent.find((e) => e.type === "transcript");
    expect(String(transcript?.payload.text)).toContain("таблица расходов");
  });

  it("«что делаешь» без активной задачи уходит в агент (не перехвачено)", () => {
    const { ctx } = fakeCtx(new TaskManager());
    expect(handleControlUtterance(ctx, "что делаешь")).toBe(false);
  });

  it("обычная реплика не перехватывается управлением", () => {
    const tasks = new TaskManager();
    tasks.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const { ctx } = fakeCtx(tasks);
    expect(handleControlUtterance(ctx, "открой блокнот")).toBe(false);
  });

  it("task.control(cancel) из UI отменяет задачу по taskId и стримит статус", () => {
    const tasks = new TaskManager();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const { ctx, sent } = fakeCtx(tasks);

    handleTaskControl(ctx, "cancel", t.taskId);
    expect(tasks.get(t.taskId)?.state).toBe("cancelled");
    expect(sent.some((e) => e.type === "task.status" && e.payload.state === "cancelled")).toBe(true);
  });

  it("ack отмены ОЗВУЧИВАЕТСЯ (и голосовая, и UI): тишина после «прекрати…» — живой баг 2026-07-03", () => {
    const tasks = new TaskManager();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const { ctx, speakQueued } = fakeCtx(tasks);

    handleTaskControl(ctx, "cancel", t.taskId, "ui"); // UI-стоп раньше был полностью немым
    expect(speakQueued).toHaveBeenCalledTimes(1);
    expect(String(speakQueued.mock.calls[0]?.[0])).toContain("Остановил");

    const tasks2 = new TaskManager();
    tasks2.create({ userId: "u1", sessionId: "s1", goal: "g2" });
    const second = fakeCtx(tasks2);
    expect(handleControlUtterance(second.ctx, "отмени")).toBe(true); // голосовой путь
    expect(second.speakQueued).toHaveBeenCalledTimes(1);
    expect(String(second.speakQueued.mock.calls[0]?.[0])).toContain("Остановил");
  });

  it("статус: голосовое «что делаешь» озвучивается, UI-статус — только текстом (панель и так видит)", () => {
    const tasks = new TaskManager();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "таблица расходов" });
    const voicePath = fakeCtx(tasks);
    expect(handleControlUtterance(voicePath.ctx, "что делаешь")).toBe(true);
    expect(voicePath.speakQueued).toHaveBeenCalledTimes(1);
    expect(String(voicePath.speakQueued.mock.calls[0]?.[0])).toContain("таблица расходов");

    const uiPath = fakeCtx(tasks);
    handleTaskControl(uiPath.ctx, "status", t.taskId, "ui");
    expect(uiPath.speakQueued).not.toHaveBeenCalled();
    expect(uiPath.sent.some((e) => e.type === "transcript")).toBe(true);
  });

  it("pause/resume из UI меняют состояние задачи (§20)", () => {
    const tasks = new TaskManager();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const { ctx } = fakeCtx(tasks);

    handleTaskControl(ctx, "pause", t.taskId);
    expect(tasks.get(t.taskId)?.state).toBe("paused");
    handleTaskControl(ctx, "resume", t.taskId);
    expect(tasks.get(t.taskId)?.state).toBe("running");
  });

  it("task.control без активной задачи — мягкий ответ, без падения", () => {
    const { ctx, sent } = fakeCtx(new TaskManager());
    handleTaskControl(ctx, "cancel");
    expect(sent.some((e) => e.type === "transcript")).toBe(true);
  });

  it("user-takeover НЕ паузит задачу (автономный Джарвис; остановка — только явная, голосом)", () => {
    const tasks = new TaskManager();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const { ctx } = fakeCtx(tasks);

    handleTakeover(ctx, true); // пользователь шевельнул мышью / печатает рядом
    expect(tasks.get(t.taskId)?.state).toBe("running"); // работа НЕ тормозится (no-op)
    handleTakeover(ctx, false);
    expect(tasks.get(t.taskId)?.state).toBe("running");
  });

  it("user-takeover без активной задачи — без падения", () => {
    const { ctx } = fakeCtx(new TaskManager());
    expect(() => handleTakeover(ctx, true)).not.toThrow();
  });
});
