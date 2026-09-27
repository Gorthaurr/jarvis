/**
 * W2 П3 (G-1/S-3) — §14 для серий через НАСТОЯЩИЙ dispatchTool: input_batch и skill_execute судятся по заполненным
 * шагам ДО отправки — один вопрос с перечнем (и печатаемым текстом), гранты с кратностью в skill.execute; «нет» →
 * ничего не ушло. Прежде спрашивал только флаг `needsReview` навыка.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, CommitGrant } from "@jarvis/protocol";
import { dispatchTool, type ToolContext } from "./dispatch.js";
import { fakeClient } from "./test-support/fake-client.js";

function setup(fg: string, approved = true, skills?: unknown) {
  const client = fakeClient({
    // Клиентский рубеж: «Отправить» в telegram без гранта не жмёт (реальная форма отказа).
    need: (st) => {
      const t = (st as { target?: { name?: string } }).target;
      return t?.name === "Отправить" ? { signature: "click:отправить", process: "telegram" } : null;
    },
  });
  const confirm = vi.fn(async (_s: string) => ({ approved, outcome: approved ? ("approved" as const) : ("denied" as const) }));
  const ctx = { session: { sendAction: client.sendAction }, userId: "u1", confirm, systemContext: () => `На переднем плане: ${fg} «Окно»`, ...(skills ? { skills } : {}) } as unknown as ToolContext;
  const runs = () => client.sent.filter((c) => c.kind === "skill.execute") as Array<ActionCommand & { approval?: { grants: CommitGrant[] } }>;
  return { ctx, confirm, runs };
}

const send = { action: "ui.invoke", target: { by: "role", role: "Button", name: "Отправить" }, params: { pattern: "invoke" } };

describe("input_batch — один вопрос с перечнем, гранты с кратностью", () => {
  it("[type «привет», invoke «Отправить»] при Telegram: 1 вопрос с «привет»; грант click:отправить ×1 telegram; клиент принял с первого раза", async () => {
    const s = setup("Telegram");
    const r = await dispatchTool("input_batch", { steps: [{ action: "input.type", params: { text: "привет" } }, send] }, s.ctx);
    expect(r.isError).toBe(false);
    expect(s.confirm).toHaveBeenCalledTimes(1);
    const q = String(s.confirm.mock.calls[0]![0]);
    expect(q).toMatch(/^Необратимое действие в программе Telegram \(мессенджер\), берст: шаг 2 — клик «Отправить»\./u);
    expect(q).toMatch(/Текст: привет/u);
    expect(s.runs()).toHaveLength(1);
    expect(s.runs()[0]!.approval?.grants).toEqual([{ signature: "click:отправить", process: "telegram", count: 1 }]);
  });

  it("«нет» владельца → declined, в ПК ничего не ушло", async () => {
    const s = setup("Telegram", false);
    const r = await dispatchTool("input_batch", { steps: [{ action: "input.type", params: { text: "привет" } }, send] }, s.ctx);
    expect(r.declined).toBe(true);
    expect(s.runs()).toHaveLength(0);
  });

  it("два «Отправить» и Enter в печати → один вопрос, гранты ×2 и key:enter ×1", async () => {
    const s = setup("Telegram");
    await dispatchTool("input_batch", { steps: [send, { action: "input.type", params: { text: "ещё\n" } }, send] }, s.ctx);
    expect(s.confirm).toHaveBeenCalledTimes(1);
    expect(s.runs()[0]!.approval?.grants).toEqual([
      { signature: "click:отправить", process: "telegram", count: 2 },
      { signature: "key:enter", process: "telegram", count: 1 },
    ]);
  });

  it("программа отслеживается по ходу серии: Блокнот спереди, app.focus Telegram → Enter судится в telegram", async () => {
    const s = setup("notepad");
    await dispatchTool("input_batch", { steps: [{ action: "input.key", params: { combo: "Enter" } }, { action: "app.focus", params: { app: "Telegram" } }, { action: "input.key", params: { combo: "Enter" } }] }, s.ctx);
    expect(s.confirm).toHaveBeenCalledTimes(1);
    expect(String(s.confirm.mock.calls[0]![0])).toMatch(/шаг 3 — Enter/u);
    expect(s.runs()[0]!.approval?.grants).toEqual([{ signature: "key:enter", process: "telegram", count: 1 }]);
  });

  it("безопасная серия (Блокнот) — без вопроса и без грантов", async () => {
    const s = setup("notepad");
    await dispatchTool("input_batch", { steps: [{ action: "input.type", params: { text: "a\nb" } }, { action: "input.key", params: { combo: "Ctrl+S" } }] }, s.ctx);
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.runs()[0]!.approval).toBeUndefined();
  });
});

describe("skill_execute — анализ заполненных шагов при запуске", () => {
  const store = (steps: unknown[], needsReview = false) => ({ get: async () => ({ id: "greet", version: 3, steps, needsReview }) });

  it("навык без needsReview, но со слотом, дающим «Отправить» в Telegram → вопрос по шагам; гранты в skill.execute", async () => {
    const s = setup("Telegram", true, store([{ action: "input.type", params: { text: "{{msg}}" } }, send]));
    const r = await dispatchTool("skill_execute", { skillId: "greet", params: { msg: "с днём рождения" } }, s.ctx);
    expect(r.isError).toBe(false);
    expect(s.confirm).toHaveBeenCalledTimes(1);
    expect(String(s.confirm.mock.calls[0]![0])).toMatch(/Текст: с днём рождения/u);
    expect(s.runs()[0]!.approval?.grants).toEqual([{ signature: "click:отправить", process: "telegram", count: 1 }]);
  });

  it("needsReview + коммит по шагам → ОДИН вопрос (по шагам), не два; needsReview без коммитов — прежний вопрос", async () => {
    const s = setup("Telegram", true, store([send], true));
    await dispatchTool("skill_execute", { skillId: "greet" }, s.ctx);
    expect(s.confirm).toHaveBeenCalledTimes(1);
    const s2 = setup("notepad", true, store([{ action: "input.key", params: { combo: "Ctrl+S" } }], true));
    await dispatchTool("skill_execute", { skillId: "greet" }, s2.ctx);
    expect(s2.confirm).toHaveBeenCalledTimes(1);
    expect(String(s2.confirm.mock.calls[0]![0])).toMatch(/Запустить навык «greet»/u);
  });
});
