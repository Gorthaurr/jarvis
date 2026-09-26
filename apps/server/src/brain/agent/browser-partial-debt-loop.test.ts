/**
 * W1-ревью р2 (loop-regress-3): берст, остановленный ПОСЛЕ k исполненных шагов (isError + partialSteps, без uncertain),
 * — исполненные шаги реальные слепые руки: долг сверки, а набор в них — composedPending (следующий клик — отправка).
 * Путь, который сервер сам предписывает («стоп на commit_confirm → сделай шаг отдельным browser_act»), давал «Заказ
 * оформлен» без взгляда. ПЕТЛЁЙ (handleUserText); browser_batch и browser_act — НАСТОЯЩИЕ хендлеры, расширение
 * подменено (deps.ext) в форме tabBatch/tabAct: `{ok:false, done, total, stoppedAt, error, code}`.
 * Реверт: верни в armUncertainDebt (loop/send-gesture.ts) выход при `r.uncertain !== true` — оба теста упадут; жест по
 * ВСЕМУ берсту вместо исполненного префикса — упадёт второй (набор «съеден» неисполненным коммитом).
 */
import { describe, expect, it, vi } from "vitest";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider, type MockTurn } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

const SITE = "https://shop.example/support";
type Reply = Record<string, unknown>;

/** Расширение: берст и одиночное действие отвечают заданной формой; вкладка одна (живой адрес — SITE). */
function ext(batch: Reply, act: Reply = { ok: true }): NonNullable<AgentDeps["ext"]> {
  return {
    connected: true,
    openOrFocus: vi.fn(async () => ({ focused: true, tabId: 5 })),
    tabRead: vi.fn(async () => ({ title: "Поддержка", url: SITE, text: "Форма обращения" })),
    tabInspect: vi.fn(async () => ({ url: SITE, elements: [] })),
    tabAct: vi.fn(async () => act),
    tabBatch: vi.fn(async () => batch),
    tabList: vi.fn(async () => ({ tabs: [{ tabId: 5, url: SITE, status: "complete", active: true }] })),
    tabClose: vi.fn(async () => ({ closed: 0 })),
    exportCookies: vi.fn(async () => ({ cookies: [] })),
  } as unknown as NonNullable<AgentDeps["ext"]>;
}

const session = () =>
  ({ sessionId: "s1", userId: "u1", sendAction: vi.fn(), send: vi.fn(), requestConfirm: vi.fn(async () => ({ requestId: "q", approved: true })) }) as unknown as Session;
const deps = (llm: MockLlmProvider, e: NonNullable<AgentDeps["ext"]>): AgentDeps => ({
  memory: new WorkingMemory(),
  llm,
  episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
  web: new MockWebProvider(),
  models: { haiku: "h", sonnet: "s", fable: "f" },
  spend: new SpendGuard(),
  userId: "u1",
  tasks: new TaskManager(),
  ext: e,
});
const call = (id: string, name: string, input: Record<string, unknown>): MockTurn => ({ toolUses: [{ id, name, input }] });
const done = (text: string): MockTurn[] => [{ text }, { text }, { text }];
const verifyNudged = (llm: MockLlmProvider): boolean => JSON.stringify(llm.requests).includes("лестница §Волна3");
const TYPE = { ref: "e3_2", intent: "type", params: { text: "Вопрос по заказу" } };

describe("р2 loop-regress-3: частично исполненный берст — долг по исполненным шагам", () => {
  it("[набор, «Отправить», ещё клик] встал на 3-м шаге → «Сообщение отправлено» без взгляда → verify-нудж", async () => {
    const stopped = { ok: false, stoppedAt: 2, done: 2, total: 3, error: "шаг 3 («click») не выполнен: элемент не найден", code: "not_found" };
    const llm = new MockLlmProvider([
      call("b1", "browser_batch", { url: SITE, steps: [TYPE, { ref: "e3_9", intent: "click" }, { ref: "e3_11", intent: "click" }] }),
      ...done("Сообщение в поддержку отправлено, сэр."),
    ]);
    await handleUserText(session(), "напиши в поддержку магазина вопрос по заказу", deps(llm, ext(stopped)));
    expect(JSON.stringify(llm.requests[1]?.messages ?? [])).toMatch(/выполнено 2 из 3/u); // стоп дошёл через хендлер
    expect(verifyNudged(llm)).toBe(true);
  });

  // Взгляд между стопом и кликом гасит долг сверки берста, но НЕ набор: исполнен префикс [набор] (коммит не нажат) —
  // следующий клик «Оформить» и есть отправка набранного (его исход сверяется только реальным взглядом).
  it("[набор, «Оформить»] встал на commit_confirm → взгляд → «Оформить» отдельным browser_act (переход) → «Заказ оформлен» → нудж", async () => {
    const stopped = { ok: false, stoppedAt: 1, done: 1, total: 2, error: "шаг 2 («click») не выполнен: кнопка-коммит", code: "commit_confirm", label: "Оформить" };
    const llm = new MockLlmProvider([
      call("b1", "browser_batch", { url: SITE, steps: [TYPE, { ref: "e3_9", intent: "click" }] }),
      call("r1", "browser_read", { url: SITE }),
      call("c1", "browser_act", { url: SITE, intent: "click", ref: "e3_9" }),
      ...done("Заказ оформлен, сэр."),
    ]);
    await handleUserText(session(), "оформи заказ с комментарием в магазине", deps(llm, ext(stopped, { ok: true, navigated: "https://shop.example/order/done" })));
    expect(JSON.stringify(llm.requests[1]?.messages ?? [])).toMatch(/кнопку-коммит/u);
    expect(JSON.stringify(llm.requests.at(-1)?.messages ?? [])).toMatch(/вызвало переход страницы/u); // клик — с наблюдением (observed)
    expect(verifyNudged(llm)).toBe(true);
  });
});
