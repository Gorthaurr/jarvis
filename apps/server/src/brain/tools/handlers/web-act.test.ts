/**
 * W4 (п.6): повтор web_act после commit_confirm страницы — ровно ОДИН вопрос и ОДИН повтор; повтор несёт подпись,
 * которую видел владелец, и тот же гард; снова commit_confirm → «кнопка сменилась», третьей отправки нет. Клиент —
 * фейк в форме настоящего ответа jarvis-browser-act (denied + data.pageCode/label); сквозь Chromium —
 * apps/client/main/e2e/web-act-e2e.chromium.test.ts. Реверт: убрать проверку второго commit_confirm → красный.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { dispatchTool, type ToolContext } from "../dispatch.js";

const CONFIRM: ActionResult = { commandId: "c", ok: false, error: { code: "denied", message: "commit_confirm" }, data: { pageCode: "commit_confirm", label: "Удалить навсегда" }, durationMs: 1 };
const DONE: ActionResult = { commandId: "c", ok: true, data: { ok: true, method: "pointer", changed: true }, durationMs: 1 };

function setup(replies: ActionResult[]) {
  const acts: ActionCommand[] = [];
  const sendAction = vi.fn(async (cmd: ActionCommand): Promise<ActionResult> => {
    if (cmd.kind === "jbrowser.read") return { commandId: "r", ok: true, data: { url: "https://shop.example/trash" }, durationMs: 1 };
    acts.push(cmd);
    return replies.shift() ?? DONE;
  });
  const confirm = vi.fn(async () => ({ approved: true, outcome: "approved" as const }));
  const ctx = { session: { sendAction }, userId: "u1", confirm } as unknown as ToolContext;
  const params = (i: number) => (acts[i] as { params?: Record<string, unknown> }).params ?? {};
  return { ctx, confirm, acts, params };
}

describe("web_act: commit_confirm страницы → один вопрос и один повтор", () => {
  it("«да» → повтор с подписью страницы и тем же гардом; результат — успех", async () => {
    const { ctx, confirm, acts, params } = setup([CONFIRM, DONE]);
    const r = await dispatchTool("web_act", { intent: "click", params: { selector: "#purge" } }, ctx);
    expect(r.isError, String(r.content)).toBeFalsy();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(acts).toHaveLength(2);
    expect(params(0).guardApproved).toBeUndefined();
    expect(params(1)).toMatchObject({ selector: "#purge", guardApproved: true, approvedLabel: "Удалить навсегда", guard: params(0).guard });
  });

  it("снова commit_confirm → «кнопка сменилась», третьей отправки и второго вопроса нет", async () => {
    const { ctx, confirm, acts } = setup([CONFIRM, CONFIRM, DONE]);
    const r = await dispatchTool("web_act", { intent: "click", params: { selector: "#purge" } }, ctx);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/сменилась/u);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(acts).toHaveLength(2);
  });

  it("подпись страницы модели не пересказывается (M11): её видит только владелец в вопросе", async () => {
    const { ctx } = setup([CONFIRM, CONFIRM]);
    const r = await dispatchTool("web_act", { intent: "click", params: { selector: "#purge" } }, ctx);
    expect(String(r.content)).not.toMatch(/Удалить навсегда/u);
  });
});
