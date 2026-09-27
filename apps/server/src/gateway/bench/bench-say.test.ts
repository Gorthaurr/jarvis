/**
 * Стенд, проводка ПЕТЛЁЙ: BenchHub (настоящий реестр + makeSessionContext + BenchSocket) → runSay → onDevText →
 * handleUserText → фоновая задача → сценарный мозг → НАСТОЯЩИЙ dispatchTool → гейт §14 на банке → ответ по политике.
 * Расширение — фейк (вкладка online.sberbank.ru, снимок с «Оплатить», tabAct — шпион).
 * Реверт-проверки: сокет, игнорирующий политику (всегда yes), — падает «нет → клика нет»; сломанная подстановка $ref
 * (литерал уходит в инструмент) — падает «да → клик по e1_1»; tool-путь без политики — падает последний тест.
 */
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@jarvis/shared";
import { SpendGuard } from "../../billing/index.js";
import { TaskManager } from "../../brain/tasks/manager.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockSttProvider, MockTtsProvider } from "../../integrations/voice-providers.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { SessionRegistry } from "../registry.js";
import type { BrainProviders, VoiceProviders } from "../router-ws.js";
import { BenchHub } from "./bench-hub.js";
import { runSay } from "./bench-say.js";
import { runTool } from "./bench-tool.js";

const PAY_URL = "https://online.sberbank.ru/pay";

function setup() {
  const tabAct = vi.fn(async () => ({ changed: true }));
  const ext = {
    connected: true,
    tabList: vi.fn(async () => ({ tabs: [{ tabId: 7, url: PAY_URL, title: "Платёж", active: true, status: "complete" }] })),
    tabInspect: vi.fn(async () => ({ url: PAY_URL, title: "Платёж", count: 1, elements: [{ ref: "e1_1", name: "Оплатить", role: "button" }] })),
    tabRead: vi.fn(async () => ({ url: PAY_URL, title: "Платёж", text: "Счёт 100 ₽" })),
    tabAct,
    openOrFocus: vi.fn(async () => ({ tabId: 7 })),
    telegramSend: vi.fn(),
    telegramSendVoice: vi.fn(),
  };
  const brain = {
    llm: new MockLlmProvider([]),
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: { forUser: () => new SpendGuard(), hydrate: async () => undefined },
    tasks: new TaskManager(),
    extBridge: ext,
  } as unknown as BrainProviders;
  const registry = new SessionRegistry();
  const providers = { stt: new MockSttProvider(), tts: new MockTtsProvider() } as unknown as VoiceProviders;
  const hub = new BenchHub({ registry, providers, brain, log: createLogger("bench-say-test"), resolveUser: async () => "u-bench" });
  return { hub, tabAct, registry };
}

const PAY_SCRIPT = {
  turns: [
    { tool_uses: [{ name: "browser_open", input: { url: PAY_URL } }] },
    { tool_uses: [{ name: "browser_inspect", input: { url: "online.sberbank.ru", query: "оплатить" } }] },
    { tool_uses: [{ name: "browser_act", input: { intent: "click", ref: "$ref:Оплатить" } }] },
    { text: "Итог по сценарию." },
    // goal-check петли (после «Открыл…»/мутации) спрашивает модель ещё раз — сценарий обязан ответить.
    { text: "Итог по сценарию." },
  ],
};

describe("/dev/bench/say: настоящая петля + §14 по политике", () => {
  it("«нет» → ровно один вопрос, клика нет, финал из сценария, задача dev", async () => {
    const { hub, tabAct, registry } = setup();
    const r = await runSay(hub, { text: "оплати счёт в сбербанке", script: PAY_SCRIPT, confirm: "no", timeoutMs: 20_000 });
    expect(r.code).toBe(200);
    const b = r.body as Record<string, any>;
    expect(b.timedOut).toBe(false);
    expect(b.llm.loopCalls).toBeGreaterThanOrEqual(4);
    expect(b.questions).toHaveLength(1);
    expect(b.questions[0]).toMatchObject({ answer: "no", outcome: "denied" });
    expect(b.questions[0].summary).toMatch(/Оплатить/);
    expect(tabAct).not.toHaveBeenCalled();
    expect(b.final).toBe("Итог по сценарию.");
    expect(b.llm.exhausted).toBe(false);
    expect(b.rounds[3].toolResults[0].text).toMatch(/Отменено/); // модель увидела честный отказ, а не «кликнул»
    expect(b.task).toMatchObject({ dev: true });
    expect(registry.size).toBe(1);
  }, 30_000);

  it("«да» → один вопрос и ровно один клик по разрешённому ref e1_1 с одобрением", async () => {
    const { hub, tabAct } = setup();
    const r = await runSay(hub, { text: "оплати счёт в сбербанке", script: PAY_SCRIPT, confirm: "yes", timeoutMs: 20_000 });
    const b = r.body as Record<string, any>;
    expect(b.questions).toHaveLength(1);
    expect(tabAct).toHaveBeenCalledTimes(1);
    const [, intent, params] = tabAct.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(intent).toBe("click");
    expect(params).toMatchObject({ ref: "e1_1", guardApproved: true });
  }, 30_000);

  it("/dev/bench/tool: $ref из прошлого inspect, «нет» → declined и клика нет; неразрешённый $ref → 400 без вызова", async () => {
    const { hub, tabAct } = setup();
    await runTool(hub, { name: "browser_open", input: { url: PAY_URL } });
    await runTool(hub, { name: "browser_inspect", input: { url: "online.sberbank.ru" } });
    const r = await runTool(hub, { name: "browser_act", input: { intent: "click", ref: "$ref:Оплатить" }, confirm: "no" });
    const b = r.body as Record<string, any>;
    expect(b.questions).toHaveLength(1);
    expect(b.result.flags.declined).toBe(true);
    expect(tabAct).not.toHaveBeenCalled();
    const miss = await runTool(hub, { name: "browser_act", input: { intent: "click", ref: "$ref:Такой кнопки нет" }, confirm: "yes" });
    expect(miss.code).toBe(400);
    expect(tabAct).not.toHaveBeenCalled();
  }, 30_000);
});
