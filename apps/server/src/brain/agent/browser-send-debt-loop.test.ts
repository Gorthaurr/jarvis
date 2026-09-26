/**
 * W1-ревью: долг сверки ОТПРАВКИ во вкладке — ПЕТЛЁЙ (handleUserText); результаты хендлера подменены, но в их настоящей
 * форме (unknownOutcome = isError + uncertain, gateDeclined = isError:false + declined).
 *  - LOOP-2: «исход неизвестен» у клика/берста — долг сверки (и долг исхода отправки), как у успеха без наблюдения;
 *  - LOOP-3: «включено» у enter — одно на петлю, гейт §14 и расширение (isOnFlag): "false"/"on" — не отправка;
 *  - LOOP-7/W1-8/T5: при конфликте верха и params побеждает params — как у хендлера и расширения;
 *  - LOOP-8: отказ §14 — ни долга сверки после честного «не отправил», ни сброса набора (повтор после «да» — отправка).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider, type MockTurn } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import type { ToolResult } from "../tools/dispatch.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

vi.mock("../tools/dispatch.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../tools/dispatch.js")>();
  return { ...mod, dispatchTool: vi.fn(mod.dispatchTool) };
});
const { dispatchTool } = await import("../tools/dispatch.js");

type Fake = (input: Record<string, unknown>) => ToolResult;
let fakes: Record<string, Fake> = {};
const okRes = (content: string, extra: Partial<ToolResult> = {}): ToolResult => ({ content, isError: false, ...extra });
/** Форма browser-failure.unknownOutcome: ошибка, но «могло и уйти». */
const unknownRes = (content: string): ToolResult => ({ content, isError: true, uncertain: true });
/** Форма dispatch-util.gateDeclined: не ошибка инструмента, но и не исполнено. */
const declinedRes = (content: string): ToolResult => ({ content, isError: false, declined: true });

beforeEach(() => {
  fakes = {};
  vi.mocked(dispatchTool).mockImplementation(async (name, input) => {
    const f = fakes[name];
    if (!f) throw new Error(`в тесте не ожидался вызов ${name}`);
    return f((input ?? {}) as Record<string, unknown>);
  });
});

const session = () => ({ sessionId: "s1", userId: "u1", sendAction: vi.fn(), send: vi.fn(), requestConfirm: vi.fn() }) as unknown as Session;
const deps = (llm: MockLlmProvider): AgentDeps => ({
  memory: new WorkingMemory(),
  llm,
  episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
  web: new MockWebProvider(),
  models: { haiku: "h", sonnet: "s", fable: "f" },
  spend: new SpendGuard(),
  userId: "u1",
  tasks: new TaskManager(),
});
const verifyNudged = (llm: MockLlmProvider): boolean => JSON.stringify(llm.requests).includes("лестница §Волна3");
const call = (id: string, name: string, input: Record<string, unknown>): MockTurn => ({ toolUses: [{ id, name, input }] });
const act = (id: string, input: Record<string, unknown>): MockTurn => call(id, "browser_act", input);
const done = (text: string): MockTurn[] => [{ text }, { text }, { text }];
const TYPED: MockTurn = act("t1", { intent: "type", ref: "e2_1", text: "буду в семь" });
const readback = (i: Record<string, unknown>): ToolResult => okRes(`Сделал «${String(i.intent)}» в браузере.`, { observed: true });

describe("LOOP-2: «исход неизвестен» у руки во вкладке — долг сверки", () => {
  it("клик «Оформить» без ответа расширения → «Заказ оформлен» без взгляда получает verify-нудж", async () => {
    fakes.browser_act = () => unknownRes("browser_act: действие ушло, расширение не ответило — ИСХОД НЕИЗВЕСТЕН, сверь.");
    const llm = new MockLlmProvider([act("c1", { intent: "click", ref: "e1_3" }), ...done("Заказ оформлен, сэр.")]);
    await handleUserText(session(), "оформи заказ в корзине на сайте", deps(llm));
    expect(verifyNudged(llm)).toBe(true);
  });

  it("берст «поле → Отправить» с неизвестным исходом — долг ИСХОДА отправки: readback соседнего set его не гасит", async () => {
    fakes.browser_batch = () => unknownRes("browser_batch: расширение не ответило после отправки — ИСХОД НЕИЗВЕСТЕН.");
    fakes.browser_act = readback;
    const llm = new MockLlmProvider([
      call("b1", "browser_batch", { steps: [{ ref: "e3_2", intent: "type", params: { text: "Вопрос по заказу" } }, { ref: "e3_9", intent: "click" }] }),
      act("s1", { intent: "set", ref: "e3_4", checked: true }),
      ...done("Сообщение отправлено, сэр."),
    ]);
    await handleUserText(session(), "напиши в поддержку магазина вопрос по заказу", deps(llm));
    expect(verifyNudged(llm)).toBe(true);
  });
});

describe("LOOP-3: «включено» у enter — то же, что у гейта §14 и расширения (isOnFlag)", () => {
  it.each(["yes", "да", "1", true])("type{enter:%s} с readback поля — набор И отправка: «Отправлено» без взгляда → нудж", async (enter) => {
    fakes.browser_act = readback;
    const llm = new MockLlmProvider([act("t1", { intent: "type", ref: "e2_1", text: "буду в семь", enter }), ...done("Отправлено, сэр.")]);
    await handleUserText(session(), "напиши Кате в чате на сайте что буду в семь", deps(llm));
    expect(verifyNudged(llm)).toBe(true);
  });

  it.each(["false", "on", "0"])("type{enter:%j} — не отправка (расширение Enter не жмёт): readback поля сверяет набор", async (enter) => {
    fakes.browser_act = readback;
    const llm = new MockLlmProvider([act("t1", { intent: "type", ref: "e2_1", text: "буду в семь", enter }), ...done("Вписал текст в поле, сэр.")]);
    await handleUserText(session(), "впиши в поле чата на сайте буду в семь", deps(llm));
    expect(verifyNudged(llm)).toBe(false);
  });
});

describe("LOOP-7/W1-8/T5: конфликт верха и params — побеждает params (как у исполнителя)", () => {
  it("type{enter:false, params:{enter:true}} — расширение жмёт Enter: это отправка → нудж", async () => {
    fakes.browser_act = readback;
    const llm = new MockLlmProvider([act("t1", { intent: "type", ref: "e2_1", text: "буду в семь", enter: false, params: { enter: true } }), ...done("Отправлено, сэр.")]);
    await handleUserText(session(), "напиши Кате в чате на сайте что буду в семь", deps(llm));
    expect(verifyNudged(llm)).toBe(true);
  });

  it("набор, затем key{combo:\"Tab\", params:{combo:\"Enter\"}} — расширение жмёт Enter: отправка → нудж", async () => {
    fakes.browser_act = readback;
    const llm = new MockLlmProvider([TYPED, act("k1", { intent: "key", combo: "Tab", params: { combo: "Enter" } }), ...done("Отправлено, сэр.")]);
    await handleUserText(session(), "напиши Кате в чате на сайте что буду в семь", deps(llm));
    expect(verifyNudged(llm)).toBe(true);
  });

  it("шаг берста {type, enter:false, params:{enter:true}} — отправка: readback соседнего set долг исхода не гасит", async () => {
    fakes.browser_batch = () => okRes("Берст выполнен: 1 из 1 шагов по ref.");
    fakes.browser_act = readback;
    const llm = new MockLlmProvider([
      call("b1", "browser_batch", { steps: [{ ref: "e3_2", intent: "type", enter: false, params: { text: "Вопрос по заказу", enter: true } }] }),
      act("s1", { intent: "set", ref: "e3_4", checked: true }),
      ...done("Сообщение отправлено, сэр."),
    ]);
    await handleUserText(session(), "напиши в поддержку магазина вопрос по заказу", deps(llm));
    expect(verifyNudged(llm)).toBe(true);
  });
});

describe("LOOP-8: отказ §14 (declined) — не нажато и не набрано", () => {
  it("набор → «Отправить» отклонён владельцем → честное «не отправил» проходит без verify-нуджа", async () => {
    fakes.browser_act = (i) => (i.intent === "click" ? declinedRes("Владелец не подтвердил отправку — не нажал.") : readback(i));
    const llm = new MockLlmProvider([TYPED, act("c1", { intent: "click", ref: "e2_9" }), ...done("Не отправил — вы не подтвердили, сэр.")]);
    await handleUserText(session(), "напиши Кате в чате на сайте что буду в семь", deps(llm));
    expect(verifyNudged(llm)).toBe(false);
  });

  it("набор → отказ → взгляд → повтор после «да» — снова ОТПРАВКА: «Отправлено» без взгляда на исход → нудж", async () => {
    let clicks = 0;
    fakes.browser_act = (i) => (i.intent === "click" && ++clicks === 1 ? declinedRes("Владелец не подтвердил отправку — не нажал.") : readback(i));
    fakes.browser_read = () => okRes("Поле сообщения: «буду в семь» (не отправлено).");
    const llm = new MockLlmProvider([
      TYPED,
      act("c1", { intent: "click", ref: "e2_9" }),
      call("r1", "browser_read", { selectorIntent: "поле сообщения" }),
      act("c2", { intent: "click", ref: "e2_9" }),
      ...done("Отправлено, сэр."),
    ]);
    await handleUserText(session(), "напиши Кате в чате на сайте что буду в семь", deps(llm));
    expect(verifyNudged(llm)).toBe(true);
  });
});
