/**
 * W1 (L-3, ревью 26.09): goal-check ищет «открыл/запустил» в ЛЮБОМ месте финала и обходил lastRoundHadVerify — честное
 * «Открыл блокнот и напечатал X» после СВЕРЕННОГО act (verified:"met") шло лишним раундом «цель достигнута?» (на подписке
 * — новая сессия с нуля). Заявка «только о запуске» теперь — лишь пока в задаче нет сверенного НЕ-запускного дела.
 * Граница: «Запустил Доту» после app_launch + скриншота (сверена лишь ПОДЦЕЛЬ — запуск) по-прежнему сверяется с целью.
 * Реверт: убери `!st.honesty.verifiedRealAction &&` в loop/nudge-policy.ts goalCheck — первые два теста упадут
 * (лишний раунд); сделай noteRealAction «любой взгляд = сверено» — упадёт третий.
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

function session(verified: "met" | "unchecked") {
  const sendAction = vi.fn((cmd: ActionCommand) =>
    Promise.resolve(
      cmd.kind === "gui.act"
        ? {
            commandId: "c",
            ok: true,
            data: {
              found: { via: "snapshot", name: "Текстовый редактор" },
              did: "UIA setValue",
              verified,
              detail: "…",
              observation: { via: "a11y", text: "поле: молоко", delta: true, changed: true },
            },
            durationMs: 1,
          }
        : cmd.kind === "screen.capture"
          ? { commandId: "c", ok: true, data: { image: "iVBOR", mediaType: "image/png" }, durationMs: 1 }
          : { commandId: "c", ok: true, durationMs: 1 },
    ),
  );
  return { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
}

function deps(llm: MockLlmProvider): AgentDeps {
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

const goalChecked = (llm: MockLlmProvider): boolean => JSON.stringify(llm.requests).includes("сверься с ИСХОДНОЙ задачей");
const LAUNCH = { id: "l1", name: "app_launch", input: { app: "блокнот" } };
const TYPE = { id: "a1", name: "act", input: { target: { text: "Текстовый редактор", role: "Edit" }, do: "type", text: "молоко" } };
const FINAL = "Открыл блокнот и напечатал «молоко», сэр.";

describe("goal-check не переспрашивает уже сверенное дело (L-3)", () => {
  it("app_launch → act verified:met → «Открыл блокнот и напечатал…» — без лишнего раунда", async () => {
    const llm = new MockLlmProvider([{ toolUses: [LAUNCH] }, { toolUses: [TYPE] }, { text: FINAL }, { text: FINAL }]);
    const reply = await handleUserText(session("met"), "открой блокнот и напечатай слово молоко", deps(llm));
    expect(goalChecked(llm)).toBe(false);
    expect(llm.requests).toHaveLength(3);
    expect(reply.voice).toMatch(/напечатал/u);
  });

  it("act без своего наблюдения, но потом РЕАЛЬНЫЙ взгляд — дело сверено, goal-check не нужен", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [LAUNCH] },
      { toolUses: [TYPE] },
      { toolUses: [{ id: "s1", name: "screen_capture", input: {} }] },
      { text: FINAL },
      { text: FINAL },
    ]);
    await handleUserText(session("unchecked"), "открой блокнот и напечатай слово молоко", deps(llm));
    expect(goalChecked(llm)).toBe(false);
    expect(llm.requests).toHaveLength(4);
  });

  it("граница: app_launch → скриншот → «Запустил Доту» — сверена лишь подготовка, goal-check сверяет с целью", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "l1", name: "app_launch", input: { app: "dota2" } }] },
      { toolUses: [{ id: "s1", name: "screen_capture", input: {} }] },
      { text: "Запустил Доту, сэр." },
      { text: "Дота запущена, поиск матча ещё не начат." },
    ]);
    await handleUserText(session("met"), "запусти поиск матча в доте", deps(llm));
    expect(goalChecked(llm)).toBe(true);
  });

  // Контроль (ревью W1-C): самоподтверждающийся mutate (громкость) + скриншот — не «сверенное дело» для заявки о запуске.
  // Реверт: убери `!isBlindMutate(tu.name) ||` в noteRealAction — тест упадёт (живой эпизод 2026-07-02 вернётся).
  it("граница: app_launch → system_volume → скриншот → «Запустил Доту» — goal-check всё равно сверяет с целью", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "l1", name: "app_launch", input: { app: "dota2" } }] },
      { toolUses: [{ id: "v1", name: "system_volume", input: { op: "up" } }] },
      { toolUses: [{ id: "s1", name: "screen_capture", input: {} }] },
      { text: "Запустил Доту, сэр." },
      { text: "Дота запущена, поиск матча ещё не начат." },
    ]);
    await handleUserText(session("met"), "запусти поиск матча в доте", deps(llm));
    expect(goalChecked(llm)).toBe(true);
  });

  // app_focus — «рука» (слепой mutate), но это подготовка (фокус окна), а не дело. Реверт: убери
  // `LAUNCH_ONLY_TOOLS.has(tu.name) ||` в noteRealAction — тест упадёт.
  it("граница: app_launch → app_focus → скриншот → «Запустил Доту» — фокус окна не дело, goal-check сверяет", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "l1", name: "app_launch", input: { app: "dota2" } }] },
      { toolUses: [{ id: "f1", name: "app_focus", input: { app: "dota2" } }] },
      { toolUses: [{ id: "s1", name: "screen_capture", input: {} }] },
      { text: "Запустил Доту, сэр." },
      { text: "Дота запущена, поиск матча ещё не начат." },
    ]);
    await handleUserText(session("met"), "запусти поиск матча в доте", deps(llm));
    expect(goalChecked(llm)).toBe(true);
  });
});
