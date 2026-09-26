/**
 * W1 (L-1, HIGH): семейный anti-runaway считал вызовы по ИМЕНИ — 14 разных browser_act по разным полям формы давали на
 * 6-м нудж «топтание», на 12-м обрыв «Застрял на browser_act»; тест в Moodle (страница вопросов → берст → следующая)
 * рвался на 12-м снимке. Теперь руки считаются по СИГНАТУРЕ цели, а новый вид страницы после действия — прогресс.
 * Граница (что обязано ловиться по-прежнему): пинг-понг двух целей, долбёжка одной кнопки при неизменной странице,
 * подряд одинаковые раунды. L-12: look{elements|text|windows} — разные семейства (счёт по каноническому имени).
 * Проверяем ПЕТЛЁЙ, результаты хендлеров подменены (браузерный хендлер пишет исполнитель B).
 */
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
import { type AgentDeps, handleUserText } from "./index.js";

vi.mock("../tools/dispatch.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../tools/dispatch.js")>();
  return { ...mod, dispatchTool: vi.fn(mod.dispatchTool) };
});
const { dispatchTool } = await import("../tools/dispatch.js");

type Fake = (input: Record<string, unknown>) => ToolResult;
let fakes: Record<string, Fake> = {};
const okRes = (content: string, extra: Partial<ToolResult> = {}): ToolResult => ({ content, isError: false, ...extra });
const savedCap = process.env.JARVIS_TOOL_FAMILY_CAP;

beforeEach(() => {
  fakes = {};
  vi.mocked(dispatchTool).mockImplementation(async (name, input) => {
    const f = fakes[name];
    if (!f) throw new Error(`в тесте не ожидался вызов ${name}`);
    return f((input ?? {}) as Record<string, unknown>);
  });
});
afterEach(() => {
  if (savedCap === undefined) delete process.env.JARVIS_TOOL_FAMILY_CAP;
  else process.env.JARVIS_TOOL_FAMILY_CAP = savedCap;
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
const call = (id: string, name: string, input: Record<string, unknown>): MockTurn => ({ toolUses: [{ id, name, input }] });
const flood = (llm: MockLlmProvider): boolean => JSON.stringify(llm.requests).includes("топтание");
const FINAL = "Анкета заполнена: все четырнадцать полей стоят как надо, сэр.";

describe("L-1: честная длинная серия рук доходит до финала", () => {
  it("14 РАЗНЫХ полей формы (set/click по разным ref) → без нуджа «топтание» и без обрыва", async () => {
    fakes.browser_act = (i) => okRes(`Сделал «${String(i.intent)}» в браузере. Результат: {"changed":true}`);
    fakes.browser_inspect = () => okRes("Анкета: 14 полей заполнены.");
    const turns: MockTurn[] = Array.from({ length: 14 }, (_, n) =>
      call(`a${n}`, "browser_act", n % 3 === 2 ? { intent: "click", ref: `e1_${n}` } : { intent: "set", ref: `e1_${n}`, value: `ответ ${n}` }),
    );
    const llm = new MockLlmProvider([...turns, call("i1", "browser_inspect", {}), { text: FINAL }, { text: FINAL }]);
    const reply = await handleUserText(session(), "заполни анкету на сайте целиком", deps(llm));
    expect(flood(llm)).toBe(false);
    expect(reply.voice).not.toMatch(/Застрял/u);
    expect(reply.voice).toMatch(/четырнадцать/u);
    expect(llm.requests).toHaveLength(16);
  });

  it("тест в Moodle: 12 страниц «снимок → берст → следующая» (ref на страницах совпадают) — без обрыва", async () => {
    let page = 0;
    fakes.browser_inspect = () => okRes(`Страница ${++page} из 12: [e1_3 radio «вариант A»] [e1_4 radio «вариант B»] [e1_9 кнопка «Следующая страница»]`);
    fakes.browser_batch = () => okRes("Берст выполнен: 2 из 2 шагов по ref.");
    const turns: MockTurn[] = [];
    for (let p = 0; p < 12; p += 1) {
      turns.push(call(`i${p}`, "browser_inspect", {}));
      turns.push(call(`b${p}`, "browser_batch", { steps: [{ ref: "e1_3", intent: "set", params: { checked: true } }, { ref: "e1_9", intent: "click" }] }));
    }
    const llm = new MockLlmProvider([...turns, call("iz", "browser_inspect", {}), { text: "Все двенадцать страниц теста пройдены, сэр." }, { text: "…" }]);
    const reply = await handleUserText(session(), "пройди тест в мудле до конца", deps(llm));
    expect(flood(llm)).toBe(false);
    expect(reply.voice).toMatch(/двенадцать страниц/u);
  });

  it("подтверждённые эффекты (readback, переход) не топтание: 8 страниц «отметь вариант → Следующая страница» по тексту", async () => {
    process.env.JARVIS_TOOL_FAMILY_CAP = "3";
    fakes.browser_act = (i) => okRes(`Сделал «${String(i.intent)}» в браузере.`, { observed: true }); // readback checked / навигация
    const turns: MockTurn[] = [];
    for (let p = 0; p < 8; p += 1) {
      turns.push(call(`s${p}`, "browser_act", { intent: "set", text: "вариант A", checked: true }));
      turns.push(call(`n${p}`, "browser_act", { intent: "click", text: "Следующая страница" }));
    }
    const llm = new MockLlmProvider([...turns, { text: "Все восемь страниц отвечены, сэр." }, { text: "…" }]);
    const reply = await handleUserText(session(), "ответь на все вопросы теста в мудле", deps(llm));
    expect(flood(llm)).toBe(false);
    expect(reply.voice).toMatch(/восемь страниц/u);
  });

  it("L-12: look{elements|text|windows} вперемешку ×7 — разные семейства (канон. имена), нуджа нет", async () => {
    fakes.ui_snapshot = () => okRes("Окно: Блокнот [Edit «Текст»]");
    fakes.screen_read_text = () => okRes("Текст экрана: список покупок");
    fakes.window_list = () => okRes("Окна: Блокнот, Chrome");
    const whats = ["elements", "text", "windows", "elements", "text", "windows", "elements"];
    const llm = new MockLlmProvider([...whats.map((w, n) => call(`l${n}`, "look", { what: w })), { text: "На экране блокнот со списком покупок, сэр." }, { text: "…" }]);
    await handleUserText(session(), "что у меня сейчас в блокноте на экране", deps(llm));
    expect(flood(llm)).toBe(false);
  });
});

describe("L-1: топтание по-прежнему ловится", () => {
  it("пинг-понг двух целей A,B,A,B… (без подтверждённого эффекта) → нудж «топтание» и честный обрыв", async () => {
    process.env.JARVIS_TOOL_FAMILY_CAP = "3";
    fakes.browser_act = () => okRes("Сделал «click» в браузере. ВНИМАНИЕ: контент страницы НЕ изменился.");
    const turns = Array.from({ length: 20 }, (_, n) => call(`p${n}`, "browser_act", { intent: "click", ref: n % 2 ? "e1_5" : "e1_4" }));
    const llm = new MockLlmProvider(turns);
    const reply = await handleUserText(session(), "нажми кнопку оплаты на сайте", deps(llm));
    expect(flood(llm)).toBe(true);
    expect(reply.voice).toMatch(/Застрял на «browser_act»/u);
    expect(llm.requests.length).toBeLessThan(12);
  });

  it("одна кнопка + взгляд, а страница НЕ меняется → нудж «топтание» (вид тот же — не прогресс)", async () => {
    process.env.JARVIS_TOOL_FAMILY_CAP = "3";
    fakes.browser_act = () => okRes("Сделал «click» в браузере. ВНИМАНИЕ: контент страницы НЕ изменился.");
    fakes.browser_inspect = () => okRes("Корзина: [e1_7 кнопка «Оформить»] — ничего не произошло.");
    const turns: MockTurn[] = [];
    for (let n = 0; n < 10; n += 1) {
      turns.push(call(`c${n}`, "browser_act", { intent: "click", ref: "e1_7" }));
      turns.push(call(`i${n}`, "browser_inspect", {}));
    }
    const llm = new MockLlmProvider(turns);
    await handleUserText(session(), "оформи заказ в корзине на сайте", deps(llm));
    expect(flood(llm)).toBe(true);
  });

  it("12 ОДИНАКОВЫХ кликов подряд — обрыв identical-repeat, как раньше", async () => {
    fakes.browser_act = () => okRes("Сделал «click» в браузере.");
    const llm = new MockLlmProvider(Array.from({ length: 12 }, (_, n) => call(`s${n}`, "browser_act", { intent: "click", ref: "e1_2" })));
    const reply = await handleUserText(session(), "нажми кнопку подписаться на сайте", deps(llm));
    expect(JSON.stringify(llm.requests)).toContain("ОДНО И ТО ЖЕ");
    expect(reply.voice).toMatch(/повторялось без видимого результата/u); // терминал runawayStuck — честный провал
    expect(llm.requests.length).toBeLessThanOrEqual(5);
  });
});
