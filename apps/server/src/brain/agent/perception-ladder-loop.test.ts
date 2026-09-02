/**
 * Лестница восприятия: первый скриншот ДО структурного взгляда получает одну подсказку.
 *
 * Числа, ради которых это сделано (форензика логов 2026-09-01): `screen_capture` — 156 вызовов,
 * самый частый инструмент вообще; `ui_snapshot` — 0 из 973 за два месяца; задачи со скриншотами
 * дают 76% успеха против 88% у остальных. Лестница существовала только словами (персона,
 * verify-нуджи), механики у неё не было.
 *
 * Проверяем ПЕТЛЁЙ: подсказка — про ПРОВОДКУ (что сработало на нужном вызове и ровно один раз).
 * Реверт-проверка прогнана: снятие условия `!sawStructuralLook` роняет кейс «после ui_snapshot
 * подсказки нет», снятие `!ladderHinted` — кейс «ровно один раз».
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

function session() {
  const sendAction = vi.fn((cmd: ActionCommand) =>
    Promise.resolve(
      cmd.kind === "screen.capture"
        ? { commandId: "c", ok: true, data: { image: "iVBOR", mediaType: "image/png" }, durationMs: 1 }
        : cmd.kind === "ui.snapshot"
          ? { commandId: "c", ok: true, data: { items: [{ handle: 1, role: "Button", name: "Играть" }] }, durationMs: 1 }
          : { commandId: "c", ok: true, durationMs: 1 },
    ),
  );
  return { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
}

async function deps(llm: MockLlmProvider): Promise<AgentDeps> {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks: new TaskManager(),
  };
}

/**
 * Сколько РАЗ подсказка реально впрыснута. Считаем вхождения в ПОСЛЕДНЕМ запросе: врезка остаётся
 * в истории и повторяется в каждом следующем запросе — счёт «в скольких запросах встретилась» дал бы
 * число раундов, а не число впрысков.
 */
const hints = (llm: MockLlmProvider): number => {
  const last = llm.requests[llm.requests.length - 1];
  return JSON.stringify(last?.messages ?? "").split("лестнице восприятия").length - 1;
};

describe("подсказка «структура раньше картинки»", () => {
  it("первый screen_capture без структурного взгляда — подсказка есть", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "s1", name: "screen_capture", input: {} }] },
      { text: "Вижу окно, сэр." },
      { text: "Вижу окно, сэр." },
    ]);
    await handleUserText(session(), "посмотри что на экране в блокноте", await deps(llm));
    expect(hints(llm)).toBe(1);
  });

  it("после ui_snapshot подсказки НЕТ — структурой уже смотрели", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "u1", name: "ui_snapshot", input: {} }] },
      { toolUses: [{ id: "s1", name: "screen_capture", input: {} }] },
      { text: "Готово, сэр." },
      { text: "Готово, сэр." },
    ]);
    await handleUserText(session(), "разберись с окном", await deps(llm));
    expect(hints(llm)).toBe(0);
  });

  it("подсказка ровно ОДНА за задачу, даже если скриншотов много", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "s1", name: "screen_capture", input: {} }] },
      { toolUses: [{ id: "s2", name: "screen_capture", input: {} }] },
      { toolUses: [{ id: "s3", name: "screen_capture", input: {} }] },
      { text: "Вижу, сэр." },
      { text: "Вижу, сэр." },
    ]);
    await handleUserText(session(), "посмотри на экран", await deps(llm));
    // Подсказка попадает в историю и повторяется в последующих запросах — считаем ПЕРВОЕ появление.
    expect(hints(llm)).toBe(1);
  });

  it("в БРАУЗЕРНОЙ задаче подсказки про UIA нет (там структура своя — browser_inspect)", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "b1", name: "browser_open", input: { url: "https://ya.ru" } }] },
      { toolUses: [{ id: "s1", name: "screen_capture", input: {} }] },
      { text: "Открыл, сэр." },
      { text: "Открыл, сэр." },
    ]);
    await handleUserText(session(), "открой сайт и посмотри", await deps(llm));
    expect(hints(llm)).toBe(0);
  });
});
