/**
 * §Волна2 (2.2) — тесты input_batch: валидация (пустой/запрещённое действие/needsLlm/кап),
 * честный «выполнено k из n» на провале шага, observed при приложенном наблюдении.
 */
import { describe, expect, it } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { inputBatch } from "./handlers/skills.js";
import type { ToolContext } from "./dispatch.js";

function ctxWith(result: Partial<ActionResult>, capture?: { cmd?: ActionCommand; timeoutMs?: number }): ToolContext {
  return {
    session: {
      sendAction: (cmd: ActionCommand, timeoutMs?: number) => {
        if (capture) {
          capture.cmd = cmd;
          capture.timeoutMs = timeoutMs;
        }
        return Promise.resolve({ commandId: "c1", ok: true, durationMs: 1, ...result } as ActionResult);
      },
    },
    web: {} as ToolContext["web"],
    episodic: {} as ToolContext["episodic"],
    userId: "u",
  };
}

const click = { action: "input.click", target: { by: "role", role: "button", name: "OK" } };

describe("input_batch (§Волна2 2.2)", () => {
  it("пустой steps → честная ошибка", async () => {
    const r = await inputBatch(ctxWith({}), { steps: [] });
    expect(r.isError).toBe(true);
  });

  it("запрещённое действие в берсте → ошибка ДО отправки (no-op клиента не маскируется успехом)", async () => {
    const r = await inputBatch(ctxWith({}), { steps: [{ action: "system.power" }] });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("system.power");
  });

  it("needsLlm-шаг → ошибка", async () => {
    const r = await inputBatch(ctxWith({}), { steps: [{ ...click, needsLlm: true }] });
    expect(r.isError).toBe(true);
  });

  it("кап 12 шагов", async () => {
    const steps = Array.from({ length: 13 }, () => ({ ...click }));
    const r = await inputBatch(ctxWith({}), { steps });
    expect(r.isError).toBe(true);
  });

  it("успех: эмитит skill.execute с синтетическим id, observed при наблюдении", async () => {
    const capture: { cmd?: ActionCommand; timeoutMs?: number } = {};
    const ctx = ctxWith({ data: { observation: { via: "a11y", text: "Кнопка ОК нажата, диалог закрыт" } } }, capture);
    const r = await inputBatch(ctx, { steps: [click, { action: "wait", params: { ms: 100 } }] });
    expect(r.isError).toBe(false);
    expect(r.observed).toBe(true);
    expect(String(r.content)).toContain("все 2 шагов");
    expect(String(r.content)).toContain("untrusted_content");
    expect(capture.cmd?.kind).toBe("skill.execute");
    if (capture.cmd?.kind === "skill.execute") {
      expect(capture.cmd.skillId.startsWith("adhoc-batch-")).toBe(true);
      expect(capture.cmd.steps).toHaveLength(2);
    }
  });

  it("провал шага k → честный «выполнено k из n» с указанием шага", async () => {
    const ctx = ctxWith({ ok: false, error: { code: "runtime", message: "элемент не найден" }, stepIndex: 1 });
    const r = await inputBatch(ctx, { steps: [click, click, click] });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("выполнено 1 из 3");
    expect(String(r.content)).toContain("шаг 2");
  });
});
