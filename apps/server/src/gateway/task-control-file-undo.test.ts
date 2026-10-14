import { describe, expect, it, vi } from "vitest";
import { TaskManager } from "../brain/tasks/manager.js";
import { classifyTaskControl } from "../brain/tasks/control.js";
import type { SessionContext } from "./router-ws.js";
import { handleControlUtterance } from "./task-control.js";

describe("откат файла и остановка задачи имеют разные маршруты", () => {
  it.each(["отмени последнее изменение файла", "Джарвис, отмени последнюю правку в файле notes.txt", "отмена последних изменений файла"])("%s не отменяет фоновую задачу", (text) => {
    const tasks = new TaskManager();
    const task = tasks.create({ userId: "u1", sessionId: "s1", goal: "другая работа" });
    const ctx = { session: { userId: "u1", send: vi.fn() }, agentDeps: { tasks },
      voice: { state: "listening", onVadEvent: vi.fn() } } as unknown as SessionContext;
    expect(handleControlUtterance(ctx, text, "text")).toBe(false);
    expect(tasks.get(task.taskId)?.state).not.toBe("cancelled");
  });

  it.each(["отмени", "отмени задачу редактирования файла", "отмени удаление файла"])("%s сохраняет прежнюю отмену задачи", (text) => {
    expect(classifyTaskControl(text).kind).toBe("cancel");
  });

  it("вырубись сохраняет приоритет", () => {
    expect(classifyTaskControl("отмени последнее изменение файла и вырубись").kind).toBe("kill");
  });
});
