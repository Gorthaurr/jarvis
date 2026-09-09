/**
 * Контроль-9 (skill-timeout-no-uncertain): таймаут КАНАЛА у skill_execute/input_batch говорит «СТАТУС НЕИЗВЕСТЕН»
 * словами, но структурного признака не нёс — журнал прерванной задачи печатал такому вызову «ОШИБКА» в
 * НЕСОКРАЩАЕМОЙ секции «СДЕЛАНО» (= «не сделано»), и «доделай» повторяло шаги, которые могли уже уйти в GUI.
 * Реверт-проверка: снять `out.uncertain`/`partialSteps` в обеих ветках таймаута → оба кейса падают.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { buildResumeDigest } from "../../agent/checkpoint.js";
import { dispatchTool, type ToolContext } from "../dispatch.js";

type Send = (cmd: ActionCommand, timeoutMs?: number) => Promise<ActionResult>;
const timeoutSend = (stepIndex?: number) =>
  vi.fn<Send>(async () => ({ commandId: "c", ok: false, error: { code: "timeout", message: "нет ответа" }, ...(stepIndex !== undefined ? { stepIndex } : {}), durationMs: 1 }));

function ctxWith(sendAction: Send): ToolContext {
  return {
    session: { sendAction },
    userId: "u1",
    skills: { get: async () => ({ id: "sk1", name: "Навык", version: 1, steps: [{ action: "input.key", params: { combo: "Enter" } }], needsReview: false }) },
  } as unknown as ToolContext;
}

describe("таймаут канала у навыка/берста — «исход неизвестен», а не «ошибка»", () => {
  it("input_batch: uncertain (число шагов таймаут КАНАЛА не знает — контроль-10 убрал мёртвую строку)", async () => {
    // Синтетический таймаут рождается в gateway/session.ts и в транспорте клиента — stepIndex там нет и быть не
    // может, поэтому `partialSteps` в этой ветке никогда не ставился. Обещать число шагов, которого нет, нельзя.
    const r = await dispatchTool("input_batch", { steps: [{ action: "input.type", params: { text: "a" } }, { action: "input.key", params: { combo: "Enter" } }] }, ctxWith(timeoutSend()));
    expect(r.isError).toBe(true);
    expect(r.uncertain).toBe(true);
    expect(r.partialSteps).toBeUndefined();
  });

  it("skill_execute: uncertain доезжает до журнала меткой «ИСХОД НЕИЗВЕСТЕН», а не «ОШИБКА»", async () => {
    const r = await dispatchTool("skill_execute", { skillId: "sk1" }, ctxWith(timeoutSend()));
    expect(r.uncertain).toBe(true);
    const digest = buildResumeDigest(
      [
        { role: "assistant", content: [{ type: "tool_use", id: "e1", name: "skill_execute", input: { skillId: "sk1" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "e1", is_error: true, content: "СТАТУС НЕИЗВЕСТЕН" }] },
      ],
      { uncertainCalls: new Set(["e1"]) },
    );
    const done = digest.split("⟪подробности захода⟫")[0] ?? "";
    expect(done).toMatch(/ИСХОД НЕИЗВЕСТЕН/u);
    expect(done).not.toMatch(/skill_execute\([^)]*\) — ОШИБКА/u);
  });
});
