/**
 * W2 П5: кадр ЗАДАЧИ на сервере — через настоящий dispatchTool. Координаты модели всегда уходят клиенту с кадром той
 * задачи, что их видела (WeakMap по ToolContext, не глобально); кадр шага capture виден следующему шагу (noteFrame
 * внутри dispatchTool); без кадра — честный отказ ДО гейтов и клиента; зум/выделение кадром задачи не становятся и
 * называют свой кадр — ни формул, ни space; кап копии: полный кадр — frameEdge, зум — maxEdge.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { VISION_CAPS } from "@jarvis/shared";
import { dispatchTool, type ToolContext } from "./dispatch.js";

type Cmd = ActionCommand & Record<string, unknown>;

/** Клиент-фейк: кадры по задаче (метка), OCR — строки в кадре, если он передан, иначе в своём o-кадре. */
function ctx(label: string, over: Partial<ToolContext> = {}): { c: ToolContext; sent: Cmd[]; confirm: ReturnType<typeof vi.fn> } {
  const sent: Cmd[] = [];
  let n = 0;
  const reply = (data: unknown): ActionResult => ({ commandId: "c", ok: true, durationMs: 1, data });
  const confirm = vi.fn(async () => ({ approved: true, outcome: "approved" as const }));
  const c = {
    session: {
      sendAction: async (cmd: Cmd): Promise<ActionResult> => {
        sent.push(cmd);
        n += 1;
        if (cmd.kind === "screen.capture") {
          const zoom = cmd.rect !== undefined;
          const zoomOf = (cmd.rect as { frame?: string } | undefined)?.frame;
          return reply({ image: "AAAA", mediaType: "image/png", width: 1920, height: 1080, frameId: `${label}${zoom ? "z" : "f"}${n}`, ...(zoomOf ? { zoomOf } : {}) });
        }
        if (cmd.kind === "screen.ocr") {
          const frame = cmd.frame as string | undefined;
          return reply({ text: "Играть", lines: [{ text: "Играть", x: 10, y: 20, w: 30, h: 10 }], width: 3840, height: 2160, frameId: `${label}o${n}`, ...(frame ? { frame } : {}), mapping: { boundsX: 0, boundsY: 0, scale: 1 } });
        }
        if (cmd.kind === "ui.snapshot") return reply({ window: "W", pid: 5, items: [{ handle: 1, role: "button", name: "Играть" }], truncated: false });
        if (cmd.kind === "wait.for") return reply({ met: true, elapsedMs: 1, polls: 1, detail: "ok" });
        return reply({});
      },
    },
    userId: "u1",
    confirm,
    systemContext: () => "Окна: 1 · На переднем плане: Блокнот «Без имени» · Пользователь: за ПК",
    ...over,
  } as unknown as ToolContext;
  return { c, sent, confirm };
}

const last = (sent: Cmd[], kind: string): Cmd | undefined => [...sent].reverse().find((s) => s.kind === kind);
const text = (r: { content: unknown }): string => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));

describe("кадр задачи — по ToolContext, не глобально", () => {
  it("две задачи: A сняла монитор 1, B — монитор 0 (позже); act{x,y} задачи A уходит с кадром A", async () => {
    const a = ctx("A");
    const b = ctx("B");
    await dispatchTool("screen_capture", { monitor: "1" }, a.c);
    await dispatchTool("screen_capture", { monitor: "0" }, b.c);
    await dispatchTool("act", { target: { x: 100, y: 50 } }, a.c);
    await dispatchTool("input_click", { target: { by: "coords", x: 7, y: 8 } }, b.c);
    expect(last(a.sent, "gui.act")?.target).toEqual({ x: 100, y: 50, frame: "Af1" });
    expect((last(b.sent, "input.click")?.target as { frame?: string }).frame).toBe("Bf1");
  });

  it("серия [capture → click x,y] через dispatchTool (как шаги act{steps}): клик несёт кадр ЭТОГО capture", async () => {
    const t = ctx("T");
    await dispatchTool("screen_capture", {}, t.c);
    await dispatchTool("screen_capture", {}, t.c); // пересняли — клик относится к свежему кадру
    await dispatchTool("act", { target: { x: 1, y: 2 }, do: "double" }, t.c);
    await dispatchTool("input_mouse", { op: "drag", x: 1, y: 2, toX: 3, toY: 4 }, t.c);
    expect((last(t.sent, "gui.act")?.target as { frame?: string }).frame).toBe("Tf2");
    expect(last(t.sent, "input.mouse")?.frame).toBe("Tf2");
  });

  it("модель назвала кадр сама (зум) — не перетирается кадром задачи", async () => {
    const t = ctx("T");
    await dispatchTool("screen_capture", {}, t.c);
    await dispatchTool("act", { target: { x: 5, y: 6, frame: "Tz9" }, to: { x: 1, y: 1 } }, t.c);
    expect(last(t.sent, "gui.act")).toMatchObject({ target: { x: 5, y: 6, frame: "Tz9" }, to: { x: 1, y: 1, frame: "Tf1" } });
  });
});

describe("без кадра — честный отказ ДО гейтов и клиента", () => {
  it.each([
    ["act", { target: { x: 1, y: 2 } }],
    ["act", { target: "Играть", do: "drag", to: { x: 1, y: 2 } }],
    ["input_click", { target: { by: "coords", x: 1, y: 2 } }],
    ["input_mouse", { op: "move", x: 1, y: 2 }],
    ["screen_capture", { rect: { x: 0, y: 0, w: 10, h: 10 } }],
    ["look", { what: "text", rect: { x: 0, y: 0, w: 10, h: 10 } }],
    ["screen_probe", { rect: { x: 0, y: 0, w: 10, h: 10 } }],
    ["wait_for", { condition: { kind: "text", text: "Готово", rect: { x: 0, y: 0, w: 10, h: 10 } } }],
  ])("%s %j → «сначала screen_capture», ничего не ушло", async (name, input) => {
    const t = ctx("T");
    const r = await dispatchTool(name, input as Record<string, unknown>, t.c);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/сначала screen_capture/u);
    expect(t.sent).toHaveLength(0);
  });

  it("берст с координатным шагом НЕ исполняется наполовину: отказ целиком, ни одного шага", async () => {
    const t = ctx("T", { systemContext: () => "Окна: 1 · На переднем плане: Блокнот · Пользователь: за ПК" });
    const r = await dispatchTool("input_batch", { steps: [{ action: "input.key", params: { combo: "ctrl+a" } }, { action: "input.click", target: { by: "coords", x: 1, y: 2 } }] }, t.c);
    expect(text(r)).toMatch(/сначала screen_capture/u);
    expect(t.sent).toHaveLength(0);
    expect(t.confirm).not.toHaveBeenCalled();
  });

  it("действия без координат и look{elements} без кадра — идут как прежде (без frame)", async () => {
    const t = ctx("T");
    await dispatchTool("act", { target: "Играть" }, t.c);
    await dispatchTool("look", { what: "elements" }, t.c);
    await dispatchTool("input_mouse", { op: "up" }, t.c);
    expect(t.sent.map((s) => s.kind)).toEqual(["gui.act", "ui.snapshot", "input.mouse"]);
    expect(JSON.stringify(t.sent)).not.toMatch(/frame/u);
  });
});

describe("датчики и зум в системе кадра", () => {
  it("зум: rect в кадре задачи, кап maxEdge; ответ называет z-кадр и велит frame — без формул и space; кадр задачи прежний", async () => {
    const t = ctx("T", { visionCap: VISION_CAPS.high });
    const full = await dispatchTool("screen_capture", {}, t.c);
    expect(last(t.sent, "screen.capture")).toMatchObject({ maxEdge: 1920, maxPixels: 3_750_000 }); // кадр 1080p-класса
    expect(text(full)).toMatch(/кадр Tf1, 1920×1080/u);
    const zoom = await dispatchTool("screen_capture", { rect: { x: 10, y: 20, w: 300, h: 200 } }, t.c);
    expect(last(t.sent, "screen.capture")).toMatchObject({ rect: { x: 10, y: 20, w: 300, h: 200, frame: "Tf1" }, maxEdge: 2576 });
    expect(text(zoom)).toMatch(/ЛУПА — свежий снимок региона из кадра Tf1: кадр Tz2/u);
    expect(text(zoom)).toContain('frame:\\"Tz2\\"');
    expect(text(zoom)).not.toMatch(/space|screenX/u);
    await dispatchTool("act", { target: { x: 1, y: 1 } }, t.c);
    expect((last(t.sent, "gui.act")?.target as { frame?: string }).frame).toBe("Tf1"); // зум кадром задачи не стал
  });

  it("OCR: с кадром задачи — система вывода = кадр задачи; без него — свой o-кадр становится кадром задачи", async () => {
    const fresh = ctx("N");
    await dispatchTool("look", { what: "text" }, fresh.c);
    expect(last(fresh.sent, "screen.ocr")).not.toHaveProperty("frame");
    await dispatchTool("act", { target: { x: 25, y: 25 } }, fresh.c);
    expect((last(fresh.sent, "gui.act")?.target as { frame?: string }).frame).toBe("No1"); // строки были в o-кадре

    const t = ctx("T");
    await dispatchTool("screen_capture", {}, t.c);
    await dispatchTool("look", { what: "text", rect: { x: 0, y: 0, w: 50, h: 50 } }, t.c);
    expect(last(t.sent, "screen.ocr")).toMatchObject({ frame: "Tf1", rect: { frame: "Tf1" } });
    await dispatchTool("act", { target: { x: 25, y: 25 } }, t.c);
    expect((last(t.sent, "gui.act")?.target as { frame?: string }).frame).toBe("Tf1"); // o-кадр не перехватил задачу
  });

  it("look{elements}, wait_for{text,rect}, screen_probe, input_batch — кадр задачи в своих полях", async () => {
    const t = ctx("T");
    await dispatchTool("screen_capture", {}, t.c);
    await dispatchTool("look", { what: "elements" }, t.c);
    await dispatchTool("wait_for", { condition: { kind: "text", text: "Готово", rect: { x: 1, y: 2, w: 3, h: 4 } }, timeoutMs: 1000 }, t.c);
    await dispatchTool("screen_probe", { rect: { x: 1, y: 2, w: 3, h: 4 } }, t.c);
    await dispatchTool("input_batch", { steps: [{ action: "input.click", target: { by: "coords", x: 1, y: 2 } }, { action: "input.mouse", params: { op: "drag", x: 1, y: 2, toX: 3, toY: 4 } }] }, t.c);
    expect(last(t.sent, "ui.snapshot")?.frame).toBe("Tf1");
    expect(last(t.sent, "wait.for")?.condition).toMatchObject({ rect: { frame: "Tf1" } });
    expect(last(t.sent, "screen.probe")?.rect).toMatchObject({ frame: "Tf1" });
    const steps = (last(t.sent, "skill.execute")?.steps ?? []) as Array<{ target?: { frame?: string }; params?: { frame?: string } }>;
    expect(steps[0]?.target?.frame).toBe("Tf1");
    expect(steps[1]?.params?.frame).toBe("Tf1");
  });
});
