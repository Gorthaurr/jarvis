/**
 * W2 (П4): серия act{steps} через НАСТОЯЩИЙ dispatchTool — каждый шаг идёт своим dispatchTool со всеми гейтами.
 * Сессия отвечает реальной формой ActionResult клиента (gui.act: found/did/verified; screen.capture: image).
 * Реверт-проверка: `mutate-loop.cjs steps-stop-first-error` (нет стопа на шаге-провале) — падает «[click ok, type
 * error, key Enter]»; `steps-cancel` — «отмена между шагами»; `steps-image-cap` — «3 снимка».
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import type { ToolResultContent } from "../../../integrations/llm.js";
import { dispatchTool, type ToolContext } from "../dispatch.js";

type Reply = (cmd: Extract<ActionCommand, { kind: "gui.act" }>) => Omit<ActionResult, "commandId" | "durationMs">;
const okAct: Reply = (cmd) => ({ ok: true, data: { found: { via: "snapshot", name: "x" }, did: `${cmd.do ?? "click"}`, verified: "unchecked" } });

function ctx(reply: Reply = okAct, over: Partial<ToolContext> = {}, approve = true) {
  const sent: ActionCommand[] = [];
  let frame = 0;
  const confirm = vi.fn(async () => ({ approved: approve, outcome: approve ? ("approved" as const) : ("denied" as const) }));
  const sendAction = async (cmd: ActionCommand): Promise<ActionResult> => {
    sent.push(cmd);
    if (cmd.kind === "screen.capture") return { commandId: "c", ok: true, durationMs: 1, data: { image: `IMG${++frame}`, mediaType: "image/png" } };
    if (cmd.kind === "gui.act") return { commandId: "c", durationMs: 1, ...reply(cmd) };
    return { commandId: "c", ok: true, durationMs: 1 };
  };
  const c = { session: { sendAction }, userId: "u1", confirm, systemContext: () => "На переднем плане: Блокнот", ...over } as unknown as ToolContext;
  return { c, sent, confirm, acts: () => sent.filter((x): x is Extract<ActionCommand, { kind: "gui.act" }> => x.kind === "gui.act") };
}

const blocks = (r: { content: string | ToolResultContent[] }): ToolResultContent[] => (typeof r.content === "string" ? [{ type: "text", text: r.content }] : r.content);
const text = (r: { content: string | ToolResultContent[] }): string => blocks(r).map((b) => (b.type === "text" ? b.text : "[IMG]")).join("\n");

describe("act{steps}: исполнение по шагу через dispatchTool", () => {
  it("[click ok, type error, key Enter] → ушло 2 команды, стоп на шаге 2, partialSteps=1, «1 из 3»", async () => {
    const t = ctx((cmd) => (cmd.do === "type" ? { ok: false, error: { code: "not_found", message: "поле «Поиск» не найдено" } } : okAct(cmd)));
    const r = await dispatchTool("act", { app: "Блокнот", steps: [{ target: "Файл" }, { target: "Поиск", do: "type", text: "x" }, { do: "key", combo: "Enter" }] }, t.c);
    expect(t.acts().map((a) => a.do ?? "click")).toEqual(["click", "type"]); // Enter после провала не ушёл
    expect(r.isError).toBe(true);
    expect(r.partialSteps).toBe(1);
    expect(text(r)).toMatch(/выполнено 1 из 3/u);
    expect(text(r)).toMatch(/поле «Поиск» не найдено/u); // причина шага-стопа доходит до модели
  });

  it("все шаги прошли: общий app сверху, промежуточные без снимков (observe:false), последний — со снимками", async () => {
    const t = ctx();
    const r = await dispatchTool("act", { app: "Блокнот", steps: [{ target: "Правка" }, { target: "Выделить всё", verify: { text: "x" } }, { do: "key", combo: "Ctrl+C" }] }, t.c);
    expect(r.isError).toBe(false);
    expect(t.acts().map((a) => a.app)).toEqual(["Блокнот", "Блокнот", "Блокнот"]);
    expect(t.acts().map((a) => a.observe)).toEqual([false, undefined, undefined]); // шаг с verify и последний — со сверкой
    expect(t.acts().some((a) => "steps" in a)).toBe(false); // серия клиенту не уходит
    expect(text(r)).toMatch(/выполнено 3 из 3/u);
  });

  it("unchecked — не стоп; verified:failed (исход неизвестен) — стоп с uncertain и partialInjected", async () => {
    const t = ctx((cmd) => (cmd.do === "type" ? { ok: true, data: { did: "type", verified: "failed", detail: "признак не наступил" } } : okAct(cmd)));
    const r = await dispatchTool("act", { steps: [{ target: "A" }, { target: "B", do: "type", text: "y" }, { target: "C" }] }, t.c);
    expect(t.acts()).toHaveLength(2);
    expect(r).toMatchObject({ isError: true, uncertain: true, partialInjected: true, partialSteps: 1 });
  });

  it("capture внутри серии → image-блок с меткой кадра; наблюдение после последней мутации → observed", async () => {
    const t = ctx();
    const r = await dispatchTool("act", { steps: [{ target: "Сохранить" }, { do: "capture" }] }, t.c);
    expect(t.sent.map((c) => c.kind)).toEqual(["gui.act", "screen.capture"]);
    const b = blocks(r);
    expect(b.some((x) => x.type === "image")).toBe(true);
    expect(text(r)).toMatch(/\[кадр .* \(шаг 2\)\]/u);
    expect(r.observed).toBe(true);
  });

  it("3 снимка → приложены 2 последние картинки, первый — текстом", async () => {
    const t = ctx();
    const r = await dispatchTool("act", { steps: [{ do: "capture" }, { target: "A" }, { do: "capture" }, { target: "B" }, { do: "capture" }] }, t.c);
    const imgs = blocks(r).filter((x) => x.type === "image") as Array<{ source: { data: string } }>;
    expect(imgs.map((i) => i.source.data)).toEqual(["IMG2", "IMG3"]);
    expect(text(r)).toMatch(/кадр шага 1 не приложен/u);
  });

  it("Enter-шаг в Telegram → вопрос владельцу на ЭТОМ шаге (гейт §14 шага), отказ → declined наружу, 1 из 2", async () => {
    const t = ctx(okAct, { systemContext: () => "На переднем плане: Telegram «Избранное»" }, false);
    const r = await dispatchTool("act", { app: "Telegram", steps: [{ target: "Сообщение", do: "type", text: "привет" }, { do: "key", combo: "Enter" }] }, t.c);
    expect(t.confirm).toHaveBeenCalledTimes(1);
    expect(t.acts().map((a) => a.do)).toEqual(["type"]); // Enter не ушёл
    expect(r).toMatchObject({ isError: false, declined: true, partialSteps: 1 });
  });

  it("отмена задачи между шагами → стоп, остальное не исполняется", async () => {
    let cancelled = false;
    const t = ctx((cmd) => {
      cancelled = true; // владелец сказал «стоп», пока шёл первый шаг
      return okAct(cmd);
    });
    t.c.isCancelled = () => cancelled;
    const r = await dispatchTool("act", { steps: [{ target: "A" }, { target: "B" }, { target: "C" }] }, t.c);
    expect(t.acts()).toHaveLength(1);
    expect(r).toMatchObject({ isError: true, partialSteps: 1 });
    expect(text(r)).toMatch(/отменили/u);
  });

  it("вуаль на шаге 2 → overlayDenied процедуры с числом сделанных шагов", async () => {
    const t = ctx((cmd) => (cmd.target === "B" ? { ok: false, error: { code: "overlay_drawing", message: "Поверх экрана открыт оверлей" } } : okAct(cmd)));
    const r = await dispatchTool("act", { steps: [{ target: "A" }, { target: "B" }, { target: "C" }] }, t.c);
    expect(r).toMatchObject({ isError: true, overlayDenied: true, overlayProcedure: true, overlayStepIndex: 1, partialSteps: 1 });
  });

  it("wait ≤ 5 с исполняется паузой; idleWaitMs наружу", async () => {
    const t = ctx();
    const r = await dispatchTool("act", { steps: [{ target: "A" }, { do: "wait", ms: 20 }, { target: "B" }] }, t.c);
    expect(t.acts()).toHaveLength(2);
    expect(r.idleWaitMs).toBe(20);
  });
});

describe("act{steps}: форма серии проверяется ДО первого шага (ничего не сделано)", () => {
  it.each([
    ["вложенные steps", { steps: [{ target: "A" }, { steps: [{ target: "B" }] }] }, /вложенные steps/u],
    ["13 шагов", { steps: Array.from({ length: 13 }, () => ({ target: "A" })) }, /максимум 12/u],
    ["wait > 5000", { steps: [{ do: "wait", ms: 6000 }] }, /1\.\.5000/u],
    ["не глагол", { steps: [{ do: "launch", target: "A" }] }, /не глагол act/u],
    ["поле берста в шаге", { steps: [{ action: "input.click", target: "A" }] }, /нет полей action/u],
    ["verify сверху", { steps: [{ target: "A" }], verify: { text: "x" } }, /только app/u],
    ["пустая серия", { steps: [] }, /непустой/u],
  ])("%s → отказ", async (_n, input, re) => {
    const t = ctx();
    const r = await dispatchTool("act", input as Record<string, unknown>, t.c);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(re);
    expect(text(r)).toMatch(/Ничего не сделано/u);
    expect(t.sent).toEqual([]);
  });
});
