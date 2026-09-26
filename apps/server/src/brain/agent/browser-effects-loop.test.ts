/**
 * W1 «браузерные руки» (контракт §6): эффекты новых интентов — ПЕТЛЁЙ (handleUserText), с подменой результата
 * хендлера браузера (его пишет исполнитель B; здесь важна проводка петли, а не расширение).
 *  - set без readback → verify-долг; с readback (observed:true) — долг снят тем же вызовом;
 *  - hover/scroll_to — ни дела, ни долга; browser_read{view:"image"} — настоящий взгляд, снимает долг клика;
 *  - ОТПРАВКА во вкладке: type→key Enter, type{enter:"true"} одним вызовом, берст «поле → кнопка» — долг сверки ИСХОДА,
 *    который readback поля (fused observed) не гасит;
 *  - browser_inspect/browser_read — одним параллельным раундом; browser_tabs{op:"close"} — строго последовательно;
 *  - журнал чекпойнта: закрытие вкладки и set — в «СДЕЛАНО», hover — нет.
 * Реверт-мутации — в отчёте волны (error-voice NEUTRAL_BROWSER_INTENTS, send-gesture webActGesture/inspectWebBatch,
 * util isParallelReadonlyCall, checkpoint effect(e.tool, e.raw)).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider, type MockTurn } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import type { ToolResult } from "../tools/dispatch.js";
import { TaskManager } from "../tasks/manager.js";
import { canonicalToolCall } from "@jarvis/tools";
import { CheckpointStore } from "./checkpoint-store.js";
import { toolCallEffect } from "./error-voice.js";
import { type AgentDeps, handleUserText } from "./index.js";
import { isParallelReadonlyCall } from "./loop/util.js";

vi.mock("../tools/dispatch.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../tools/dispatch.js")>();
  return { ...mod, dispatchTool: vi.fn(mod.dispatchTool) };
});
const { dispatchTool } = await import("../tools/dispatch.js");
const actual = (await vi.importActual<typeof import("../tools/dispatch.js")>("../tools/dispatch.js")).dispatchTool;

type Fake = (input: Record<string, unknown>) => ToolResult | Promise<ToolResult>;
let fakes: Record<string, Fake> = {};
const okRes = (content: string, extra: Partial<ToolResult> = {}): ToolResult => ({ content, isError: false, ...extra });

beforeEach(() => {
  fakes = {};
  vi.mocked(dispatchTool).mockImplementation(async (name, input, ctx) => {
    const f = fakes[name];
    return f ? f((input ?? {}) as Record<string, unknown>) : actual(name, input, ctx);
  });
});

const session = () => ({ sessionId: "s1", userId: "u1", sendAction: vi.fn(), send: vi.fn(), requestConfirm: vi.fn() }) as unknown as Session;
function deps(llm: MockLlmProvider, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks: new TaskManager(),
    ...over,
  };
}
/** Оба варианта verify-нуджа (заявка результата / просто действие) ссылаются на лестницу. */
const verifyNudged = (llm: MockLlmProvider): boolean => JSON.stringify(llm.requests).includes("лестница §Волна3");
const act = (id: string, input: Record<string, unknown>): MockTurn => ({ toolUses: [{ id, name: "browser_act", input }] });
const done = (text: string): MockTurn[] => [{ text }, { text }, { text }];

describe("W1: эффекты браузерных интентов в петле", () => {
  it("set БЕЗ readback — слепое дело: финал без сверки получает verify-нудж", async () => {
    fakes.browser_act = () => okRes("Сделал «set» в браузере.");
    const llm = new MockLlmProvider([act("a1", { intent: "set", ref: "e1_3", value: "Иванов" }), ...done("Заполнил фамилию, сэр.")]);
    await handleUserText(session(), "впиши фамилию Иванов в поле на сайте", deps(llm));
    expect(verifyNudged(llm)).toBe(true);
  });

  it("set С readback (observed:true от хендлера) — сверка в том же вызове, нуджа нет", async () => {
    fakes.browser_act = () => okRes("Сделал «set» в браузере. значение поля → Иванов", { observed: true });
    const llm = new MockLlmProvider([act("a1", { intent: "set", ref: "e1_3", value: "Иванов" }), ...done("Заполнил фамилию, сэр.")]);
    await handleUserText(session(), "впиши фамилию Иванов в поле на сайте", deps(llm));
    expect(verifyNudged(llm)).toBe(false);
    expect(llm.requests).toHaveLength(2);
  });

  it("hover — не дело и не долг: финал без сверки проходит", async () => {
    fakes.browser_act = () => okRes("Сделал «hover» в браузере.");
    const llm = new MockLlmProvider([act("h1", { intent: "hover", ref: "e1_7" }), ...done("Навёл курсор на меню, сэр.")]);
    await handleUserText(session(), "наведи курсор на меню каталога на сайте", deps(llm));
    expect(verifyNudged(llm)).toBe(false);
    expect(llm.requests).toHaveLength(2);
  });

  it("browser_read{view:\"image\"} — настоящий взгляд: снимает долг слепого клика", async () => {
    fakes.browser_act = () => okRes("Сделал «click» в браузере. Результат: {\"changed\":true}");
    fakes.browser_read = () => ({
      content: [
        { type: "text", text: "Снимок вкладки (видимая область)." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
      ],
      isError: false,
    });
    const llm = new MockLlmProvider([
      act("c1", { intent: "click", ref: "e1_4" }),
      { toolUses: [{ id: "r1", name: "browser_read", input: { view: "image" } }] },
      ...done("Кнопка нажата — открылось окно оплаты, сэр."),
    ]);
    await handleUserText(session(), "нажми кнопку оформить на сайте", deps(llm));
    expect(verifyNudged(llm)).toBe(false);
  });
});

describe("W1: отправка во вкладке — долг сверки ИСХОДА (readback поля его не гасит)", () => {
  it("type → key Enter (оба с readback) = отправка: финал «Отправлено» без взгляда → нудж", async () => {
    fakes.browser_act = (i) => okRes(`Сделал «${String(i.intent)}» в браузере.`, { observed: true });
    const llm = new MockLlmProvider([
      act("t1", { intent: "type", ref: "e2_1", text: "буду в семь" }),
      act("k1", { intent: "key", combo: "Enter" }),
      ...done("Отправлено, сэр."),
    ]);
    await handleUserText(session(), "напиши Кате в чате на сайте что буду в семь", deps(llm));
    expect(verifyNudged(llm)).toBe(true);
  });

  it("type с enter:\"true\" СТРОКОЙ (прежняя форма params) — набор и коммит одним вызовом → нудж", async () => {
    fakes.browser_act = () => okRes("Сделал «type» в браузере.", { observed: true });
    const llm = new MockLlmProvider([act("t1", { intent: "type", params: { ref: "e2_1", text: "буду в семь", enter: "true" } }), ...done("Отправлено, сэр.")]);
    await handleUserText(session(), "напиши Кате в чате на сайте что буду в семь", deps(llm));
    expect(verifyNudged(llm)).toBe(true);
  });

  it("берст «поле → кнопка», затем set с readback — долг отправки fused-наблюдение не гасит", async () => {
    fakes.browser_batch = () => okRes("Берст выполнен: 2 из 2 шагов по ref.");
    fakes.browser_act = () => okRes("Сделал «set» в браузере.", { observed: true });
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "b1", name: "browser_batch", input: { steps: [{ ref: "e3_2", intent: "set", params: { value: "Вопрос по заказу" } }, { ref: "e3_9", intent: "click" }] } }] },
      act("s1", { intent: "set", ref: "e3_4", checked: true }),
      ...done("Форма отправлена, сэр."),
    ]);
    await handleUserText(session(), "заполни и отправь форму обратной связи на сайте", deps(llm));
    expect(verifyNudged(llm)).toBe(true);
  });
});

describe("W1: параллельные чтения вкладки", () => {
  /** Первый вызов ждёт старта второго (≤300 мс): параллельно → «par», последовательно → «seq». */
  function raceFakes(first: string, second: string): void {
    let started!: () => void;
    const secondStarted = new Promise<void>((r) => (started = r));
    fakes[first] = async () => okRes(await Promise.race([secondStarted.then(() => "par"), new Promise<string>((r) => setTimeout(() => r("seq"), 300))]));
    fakes[second] = () => {
      started();
      return okRes("текст страницы");
    };
  }
  const firstResult = (llm: MockLlmProvider): string => JSON.stringify(llm.requests[1]?.messages ?? []);

  it("browser_inspect{query} + browser_read — один параллельный раунд", async () => {
    raceFakes("browser_inspect", "browser_read");
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "i1", name: "browser_inspect", input: { query: "фамилия" } }, { id: "r1", name: "browser_read", input: { selectorIntent: "итого" } }] },
      { text: "Поле фамилии есть, итог — 1200 рублей." },
    ]);
    await handleUserText(session(), "посмотри форму на сайте и сколько там итого", deps(llm));
    expect(firstResult(llm)).toContain('"par"');
  });

  it("browser_tabs{op:\"close\"} рядом с чтением — НЕ параллельно (закрытие — не чтение)", async () => {
    // Фасад канонизирует browser_tabs{op:"close"} в browser_close ДО петли и dispatch (facades.ts).
    raceFakes("browser_close", "browser_read");
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "c1", name: "browser_tabs", input: { op: "close", tabId: 7 } }, { id: "r1", name: "browser_read", input: { selectorIntent: "итого" } }] },
      { text: "Закрыл вкладку, итог — 1200 рублей." },
      { text: "Закрыл вкладку, итог — 1200 рублей." },
    ]);
    await handleUserText(session(), "закрой ту вкладку и прочитай итого на этой", deps(llm));
    expect(firstResult(llm)).toContain('"seq"');
  });

  it("W1-ревью T8: канонический browser_tabs{op:\"close\"} — дело и не параллельное чтение (без веток по сырому имени)", () => {
    const c = canonicalToolCall("browser_tabs", { op: "close", tabId: 7 });
    expect(isParallelReadonlyCall(c.name, c.input)).toBe(false);
    expect(toolCallEffect(c.name, c.input)).toBe("mutate");
    const list = canonicalToolCall("browser_tabs", {});
    expect(isParallelReadonlyCall(list.name, list.input)).toBe(true); // список вкладок — по-прежнему чтение
  });

  it("W1-ревью T4: два browser_read{view:\"image\"} (зум по ref) — строго последовательно: вьюпорт и прокрутка общие", async () => {
    let started!: () => void;
    const secondStarted = new Promise<void>((r) => (started = r));
    fakes.browser_read = async (i) => {
      if (i.ref === "e1_2") {
        started();
        return okRes("снимок 2");
      }
      return okRes(await Promise.race([secondStarted.then(() => "par"), new Promise<string>((r) => setTimeout(() => r("seq"), 300))]));
    };
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "z1", name: "browser_read", input: { view: "image", ref: "e1_1" } }, { id: "z2", name: "browser_read", input: { view: "image", ref: "e1_2" } }] },
      { text: "На обоих снимках цена 1200 рублей, сэр." },
    ]);
    await handleUserText(session(), "приблизь обе карточки товара на сайте и сравни цены", deps(llm));
    expect(firstResult(llm)).toContain('"seq"');
  });
});

describe("W1: журнал чекпойнта судит эффект по входу", () => {
  const ENV = ["JARVIS_CONTEXT_SOFT_TOKENS", "JARVIS_CONTEXT_HARD_TOKENS"] as const;
  let dir = "";
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-w1-cp-"));
    for (const k of ENV) saved[k] = process.env[k];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("обрыв по контексту: закрытие вкладки и set — в «СДЕЛАНО» (не повторять), hover — нет", async () => {
    process.env.JARVIS_CONTEXT_SOFT_TOKENS = "20000";
    process.env.JARVIS_CONTEXT_HARD_TOKENS = "30000";
    fakes.browser_act = (i) => okRes(`Сделал «${String(i.intent)}» в браузере.`);
    fakes.browser_close = () => okRes("Закрыл вкладку 7.");
    const checkpoints = new CheckpointStore(dir);
    const llm = new MockLlmProvider([
      {
        toolUses: [
          { id: "h1", name: "browser_act", input: { intent: "hover", ref: "e1_7" } },
          { id: "c1", name: "browser_tabs", input: { op: "close", tabId: 7 } },
          { id: "s1", name: "browser_act", input: { intent: "set", ref: "e1_3", value: "Иванов" } },
        ],
        usage: { inputTokens: 50_000 },
      },
      { text: "не должно вызваться" },
    ]);
    await handleUserText(session(), "закрой лишнюю вкладку и заполни анкету на сайте", deps(llm, { checkpoints }));
    const digest = checkpoints.peek("u1")?.digest ?? "";
    const doneSection = digest.split("⟪подробности захода⟫")[0] ?? "";
    expect(doneSection).toMatch(/browser_close\([^)]*close/u);
    expect(doneSection).toMatch(/browser_act\([^)]*set/u);
    expect(doneSection).not.toMatch(/hover/u);
  });
});
