import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import type { SkillProvider } from "../../memory/skills.js";
import { type ToolContext, dispatchTool } from "./dispatch.js";

const provider: SkillProvider = {
  async list() {
    return [
      { id: "send_vk", name: "Написать в VK", version: 3, needsReview: true },
      { id: "open_report", name: "Открыть отчёт", version: 1, needsReview: false },
    ];
  },
  async get(_userId, id) {
    if (id === "open_report") return { id, version: 1, steps: [{ action: "app.focus" }], needsReview: false };
    if (id === "send_vk") return { id, version: 3, steps: [{ action: "message.send" }], needsReview: true };
    return null;
  },
  async save(_userId, input) {
    return { id: "saved", name: input.name, version: 1 };
  },
  async recall() {
    return null;
  },
};

function makeCtx(over: Partial<ToolContext> = {}): { ctx: ToolContext; sendAction: ReturnType<typeof vi.fn> } {
  const sendAction = vi.fn((_cmd: ActionCommand, _t?: number) =>
    Promise.resolve({ commandId: "c", ok: true, durationMs: 1, data: { stepIndex: 1 } }),
  );
  const ctx = {
    session: { sendAction },
    web: {} as ToolContext["web"],
    episodic: {} as ToolContext["episodic"],
    userId: "u1",
    skills: provider,
    ...over,
  } as unknown as ToolContext;
  return { ctx, sendAction };
}

describe("skill_list / skill_execute (§8 — выученные показом навыки)", () => {
  it("skill_list возвращает каталог с id/именем/версией и пометкой ревью", async () => {
    const { ctx } = makeCtx();
    const r = await dispatchTool("skill_list", {}, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("open_report");
    expect(r.content).toContain("send_vk");
    expect(r.content).toContain("требует подтверждения"); // у send_vk guard-шаг
  });

  it("skill_execute по id резолвит шаги и эмитит skill.execute клиенту", async () => {
    const { ctx, sendAction } = makeCtx();
    const r = await dispatchTool("skill_execute", { skillId: "open_report" }, ctx);
    expect(r.isError).toBe(false);
    const cmd = sendAction.mock.calls[0]?.[0] as Extract<ActionCommand, { kind: "skill.execute" }>;
    expect(cmd.kind).toBe("skill.execute");
    expect(cmd.skillId).toBe("open_report");
    expect(cmd.version).toBe(1);
    expect(cmd.steps).toEqual([{ action: "app.focus" }]); // сервер подставил шаги, не модель
  });

  it("несуществующий навык → ошибка", async () => {
    const { ctx } = makeCtx();
    const r = await dispatchTool("skill_execute", { skillId: "нет_такого" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("не найден");
  });

  it("guard-навык требует подтверждения; без канала confirm — отказ", async () => {
    const { ctx, sendAction } = makeCtx({ confirm: undefined });
    const r = await dispatchTool("skill_execute", { skillId: "send_vk" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("подтверждение");
    expect(sendAction).not.toHaveBeenCalled(); // не запустили необратимый навык
  });

  it("guard-навык: подтверждение получено → запускается", async () => {
    const confirm = vi.fn(async () => ({ approved: true }));
    const { ctx, sendAction } = makeCtx({ confirm });
    const r = await dispatchTool("skill_execute", { skillId: "send_vk" }, ctx);
    expect(confirm).toHaveBeenCalled();
    expect(r.isError).toBe(false);
    expect(sendAction).toHaveBeenCalled();
  });

  it("guard-навык: пользователь отклонил → не запускается, нейтральный ответ", async () => {
    const confirm = vi.fn(async () => ({ approved: false }));
    const { ctx, sendAction } = makeCtx({ confirm });
    const r = await dispatchTool("skill_execute", { skillId: "send_vk" }, ctx);
    expect(r.isError).toBe(false); // отказ — не ошибка инструмента
    expect(r.content).toContain("Отменено");
    expect(sendAction).not.toHaveBeenCalled();
  });
});

describe("skill_save (§8 HERMES — самообучение навыком)", () => {
  it("сохраняет навык через провайдер и подтверждает", async () => {
    const save = vi.fn(async (_u: string, input: { name: string }) => ({ id: "s", name: input.name, version: 1 }));
    const { ctx } = makeCtx({ skills: { ...provider, save } });
    const r = await dispatchTool(
      "skill_save",
      { name: "Отчёт в Telegram", when: "когда просят прислать отчёт в телегу", procedure: "1. собрать\n2. отправить" },
      ctx,
    );
    expect(r.isError).toBe(false);
    expect(save).toHaveBeenCalledWith("u1", {
      name: "Отчёт в Telegram",
      when: "когда просят прислать отчёт в телегу",
      procedure: "1. собрать\n2. отправить",
    });
    expect(r.content).toContain("сохранён");
  });

  it("без name/procedure → ошибка, провайдер не зовётся", async () => {
    const save = vi.fn();
    const { ctx } = makeCtx({ skills: { ...provider, save } });
    const r = await dispatchTool("skill_save", { name: "", when: "x", procedure: "" }, ctx);
    expect(r.isError).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("нет провайдера навыков → ошибка", async () => {
    const { ctx } = makeCtx({ skills: undefined });
    const r = await dispatchTool("skill_save", { name: "X", when: "y", procedure: "z" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("недоступно");
  });
});
