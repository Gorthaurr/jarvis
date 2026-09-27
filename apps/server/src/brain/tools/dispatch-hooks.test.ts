/**
 * W2 (пакет 0): порядок хуков dispatchTool — контракт для пакетов П1–П5.
 *  - маршрут act{steps} стоит ДО гейтов: сама серия не спрашивает владельца (каждый шаг спрашивает сам, П4) и не уходит клиенту;
 *  - кап зрения задачи едет в screen.capture (maxEdge/maxPixels), без капа — прежняя команда;
 *  - taskVisionCap: подписка ∪ тиры API по состоянию каналов.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { VISION_CAPS } from "@jarvis/shared";
import { dispatchTool, type ToolContext } from "./dispatch.js";
import { taskVisionCap } from "../agent/loop/tool-ctx.js";

function ctx(over: Partial<ToolContext> = {}): { c: ToolContext; sent: ActionCommand[]; confirm: ReturnType<typeof vi.fn> } {
  const sent: ActionCommand[] = [];
  const confirm = vi.fn(async () => ({ approved: true, outcome: "approved" as const }));
  const c = {
    session: {
      sendAction: async (cmd: ActionCommand): Promise<ActionResult> => {
        sent.push(cmd);
        return { commandId: "c", ok: true, durationMs: 1, data: { image: "AAAA", mediaType: "image/png" } };
      },
    },
    userId: "u1",
    confirm,
    systemContext: () => "Окна: 2 · На переднем плане: Telegram «Избранное» · Пользователь: за ПК",
    ...over,
  } as unknown as ToolContext;
  return { c, sent, confirm };
}

describe("dispatchTool — порядок хуков", () => {
  it("act{steps} уходит в маршрут серии ДО §14-гейта: сама серия не спрашивает — спрашивает ТОЛЬКО Enter-шаг (П4), серия клиенту не уходит", async () => {
    const { c, sent, confirm } = ctx();
    const r = await dispatchTool("act", { app: "Telegram", steps: [{ target: "Сообщение", do: "type", text: "привет" }, { do: "key", combo: "Enter" }] }, c);
    expect(confirm).toHaveBeenCalledTimes(1); // один вопрос — на Enter; двойного (серия + шаг) нет
    expect(sent.map((x) => (x as { do?: string }).do)).toEqual(["type", "key"]);
    expect(sent.some((x) => "steps" in x)).toBe(false);
    expect(r.isError).toBe(false);
  });

  it("тот же Enter одним act — гейт спрашивает (маршрут серии не перехватывает обычный act)", async () => {
    const { c, sent, confirm } = ctx();
    await dispatchTool("act", { app: "Telegram", do: "key", combo: "Enter" }, c);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });
});

describe("screen_capture — кап зрения задачи", () => {
  it("с visionCap команда несёт maxEdge/maxPixels; без него — прежняя форма", async () => {
    const a = ctx({ visionCap: VISION_CAPS.high });
    await dispatchTool("screen_capture", {}, a.c);
    // W2 П5 (решение №2): полный кадр — 1080p-класса (frameEdge), до maxEdge (2576) добирает только зум — frame-memory.test.
    expect(a.sent[0]).toMatchObject({ kind: "screen.capture", maxEdge: 1920, maxPixels: 3_750_000 });
    const b = ctx();
    await dispatchTool("screen_capture", {}, b.c);
    expect(b.sent[0]).not.toHaveProperty("maxEdge");
  });
});

describe("taskVisionCap", () => {
  const models = { haiku: "claude-sonnet-4-6", sonnet: "claude-sonnet-4-6", fable: "claude-opus-4-8" };
  it("основной канал выключен → только подписка (Opus 5, high); оба живы → минимум (Sonnet 4.6 → std)", () => {
    const off = { channelStatus: () => ({ primary: "off" as const, subscriptionLive: true }) };
    expect(taskVisionCap({ llm: off as never, models })).toEqual(VISION_CAPS.high);
    const both = { channelStatus: () => ({ primary: "ok" as const, subscriptionLive: true }) };
    expect(taskVisionCap({ llm: both as never, models })).toEqual(VISION_CAPS.std);
    const apiOnly = { channelStatus: () => ({ primary: "ok" as const, subscriptionLive: false }) };
    expect(taskVisionCap({ llm: apiOnly as never, models: { haiku: "claude-opus-5", sonnet: "claude-opus-5", fable: "claude-fable-5" } })).toEqual(VISION_CAPS.high);
  });
});
