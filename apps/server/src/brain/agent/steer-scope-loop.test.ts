/**
 * 🔴 Тесты против РЕАЛЬНОЙ петли (`handleUserText`) на связку «§20 scope → steer → ack».
 *
 * Почему петлёй, а не только юнитом на `classifyTaskScope`: дефект жил именно в ПРОВОДКЕ — классификатор
 * вызывался БЕЗ цели активной задачи, поэтому любая реплика с глаголом правки впрыскивалась steer'ом в
 * ЧУЖУЮ задачу, и владельцу произносили «Принял, поправляю» о том, чего не произошло (закон честности:
 * ack обязан звучать только при РЕАЛЬНОМ впрыске в задачу, к которой реплика относится).
 *
 * Что закрываем:
 *  1) смена темы с глаголом правки при активной задаче → НЕТ «поправляю» и НЕТ впрыска в чужую задачу;
 *  2) настоящая правка ПО ТЕМЕ по-прежнему впрыскивается и подтверждается («не переусердствовали»);
 *  3) маркер отказа («не то») остаётся правкой текущего хода.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

const ACTIVE_GOAL = "напиши отчет про рынок электромобилей";

function session(): Session {
  return {
    sessionId: "s1",
    userId: "u1",
    sendAction: vi.fn((_c: ActionCommand) => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 })),
    send: vi.fn(),
    requestConfirm: vi.fn(),
  } as unknown as Session;
}

/** Дежурная петля: любая новая задача отвечает текстом и завершается (нам важен только scope-гейт). */
function deps(tasks: TaskManager): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm: new MockLlmProvider([{ text: "Сделано." }, { text: "Сделано." }, { text: "Сделано." }]),
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks,
  };
}

/** Активная фоновая задача владельца — цель, в которую полетел бы steer. */
function withActiveTask(): { tasks: TaskManager; pending: () => string[] } {
  const tasks = new TaskManager();
  const t = tasks.create({ userId: "u1", sessionId: "s1", goal: ACTIVE_GOAL });
  return { tasks, pending: () => tasks.get(t.taskId)?.steer.pending ?? [] };
}

describe("§20 scope через ПЕТЛЮ: ack «поправляю» только при реальном впрыске", () => {
  it("🔴 смена темы с глаголом правки: ни «поправляю», ни впрыска в чужую задачу", async () => {
    const { tasks, pending } = withActiveTask();
    const reply = await handleUserText(session(), "добавь напоминание позвонить маме завтра", deps(tasks));
    expect(reply.voice).not.toContain("поправляю"); // до фикса произносилось «Принял, поправляю.»
    expect(pending()).toEqual([]); // и реплика уезжала в ЧУЖУЮ задачу
  });

  it("🔴 смена темы (другой домен): «исправь баг в билде» не правит отчёт", async () => {
    const { tasks, pending } = withActiveTask();
    const reply = await handleUserText(session(), "исправь баг в билде", deps(tasks));
    expect(reply.voice).not.toContain("поправляю");
    expect(pending()).toEqual([]);
  });

  it("настоящая правка ПО ТЕМЕ по-прежнему впрыскивается и подтверждается (не переусердствовали)", async () => {
    const { tasks, pending } = withActiveTask();
    const reply = await handleUserText(session(), "добавь раздел про флот", deps(tasks));
    expect(reply.voice).toBe("Принял, поправляю.");
    expect(pending()).toEqual(["добавь раздел про флот"]);
  });

  it("маркер отказа («не то») остаётся правкой текущего хода", async () => {
    const { tasks, pending } = withActiveTask();
    const reply = await handleUserText(session(), "нет, не то", deps(tasks));
    expect(reply.voice).toBe("Принял, поправляю.");
    expect(pending().length).toBe(1);
  });
});
