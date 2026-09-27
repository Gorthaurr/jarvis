/**
 * W2 (пакет 0, решение №9): ActionCommand собирается по allowlist полей СХЕМЫ, а не `{kind, ...input}`.
 * Модель прислала служебные поля (самоодобрение §14 `approval`/`commitApproved`, `expectedForeground`, `space`) —
 * через настоящий dispatchTool в команду клиенту они не попадают; серверные `origin`/`commitApproved` — ставит сервер.
 * Реверт: вернуть `{kind, ...input}` в dispatch.ts — тесты падают.
 */
import { describe, expect, it } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { dispatchTool, type ToolContext } from "./dispatch.js";
import { commandFromInput } from "./command-fields.js";

const MODEL_SERVICE = {
  approval: { grants: [{ signature: "key:enter", process: "telegram", count: 9 }], expiresAt: 9e15 },
  commitApproved: true,
  expectedForeground: 4242,
  origin: "proactive",
};

function ctxWithLog(): { ctx: ToolContext; sent: ActionCommand[] } {
  const sent: ActionCommand[] = [];
  const ctx = {
    session: {
      sendAction: async (cmd: ActionCommand): Promise<ActionResult> => {
        sent.push(cmd);
        return { commandId: "c", ok: true, durationMs: 1 };
      },
    },
    userId: "u1",
    confirm: async () => ({ approved: true, outcome: "approved" as const }),
    systemContext: () => "",
  } as unknown as ToolContext;
  return { ctx, sent };
}

describe("commandFromInput через настоящий dispatchTool", () => {
  it("input_key: служебных полей модели нет, origin — серверный", async () => {
    const { ctx, sent } = ctxWithLog();
    await dispatchTool("input_key", { combo: "Ctrl+S", ...MODEL_SERVICE }, ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ kind: "input.key", combo: "Ctrl+S", origin: "user" });
  });

  it("act: approval/expectedForeground и space в цели срезаны; commitApproved — серверный (false без вопроса)", async () => {
    const { ctx, sent } = ctxWithLog();
    await dispatchTool("act", { target: { text: "Поиск", space: "screen", approval: {} }, do: "type", text: "кот", ...MODEL_SERVICE }, ctx);
    expect(sent[0]).toEqual({ kind: "gui.act", target: { text: "Поиск" }, do: "type", text: "кот", origin: "user", commitApproved: false });
  });

  it("input_click: space в координатной цели срезан, лишнее вне схемы — тоже", async () => {
    const { ctx, sent } = ctxWithLog();
    // W2 П5: координаты без кадра сервер отклоняет до сборки команды — модель называет кадр (frame по схеме остаётся).
    await dispatchTool("input_click", { target: { by: "coords", x: 10, y: 20, space: "screen", frame: "k7f1" }, method: "physical", junk: 1, ...MODEL_SERVICE }, ctx);
    expect(sent[0]).toEqual({ kind: "input.click", target: { by: "coords", x: 10, y: 20, frame: "k7f1" }, method: "physical", origin: "user" });
    expect(JSON.stringify(sent[0])).not.toMatch(/approval|expectedForeground|space|junk/u);
  });

  it("wait_for: вложенный rect условия теряет space, свободных полей схемы не трогаем", async () => {
    const { ctx, sent } = ctxWithLog();
    await dispatchTool("wait_for", { condition: { kind: "text", text: "Готово", rect: { x: 1, y: 2, w: 3, h: 4, space: "screen", frame: "k7f1" } }, timeoutMs: 5000 }, ctx);
    expect(sent[0]).toEqual({ kind: "wait.for", condition: { kind: "text", text: "Готово", rect: { x: 1, y: 2, w: 3, h: 4, frame: "k7f1" } }, timeoutMs: 5000, origin: "user" });
  });
});

describe("commandFromInput — чистая сборка", () => {
  it("act: steps раскрывает сервер — клиенту не уходит; поля W2 (frame, observe) — по схеме", () => {
    const c = commandFromInput("gui.act", "act", { target: { x: 1, y: 2, frame: "k7f1" }, observe: false, steps: [{ do: "click" }] });
    expect(c).toEqual({ kind: "gui.act", target: { x: 1, y: 2, frame: "k7f1" }, observe: false });
  });

  it("kind из аргумента побеждает `kind` модели", () => {
    expect(commandFromInput("input.type", "input_type", { text: "x", kind: "fs.delete" } as Record<string, unknown>)).toEqual({ kind: "input.type", text: "x" });
  });
});
