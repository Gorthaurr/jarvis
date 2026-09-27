/**
 * W1-ревью (LOOP-1, LOOP-6): семейный счёт рук на ЖИВОЙ странице — ПЕТЛЁЙ (handleUserText). browser_read идёт через
 * НАСТОЯЩИЙ хендлер (строку плеера и снимок вкладки он собирает сам — фикстура = реальная форма), расширение подменено
 * (deps.ext); browser_act подменён (§14-гейт тут ни при чём).
 *  - LOOP-1: позиция плеера и base64 снимка меняются на каждом взгляде — это не новый вид страницы: долбёжка одной
 *    кнопки ловится нуджем «топтание», как на статичной странице (family-series-loop).
 *  - LOOP-6: hover/scroll_to к РАЗНЫМ целям — не топтание (счёт по сигнатуре цели); пинг-понг наведений — ловится.
 *  - р2 (loop-regress-2, loop-tests-2): «тот же вид» = нормализованный текст (числа → #) И нет руки по новой цели между
 *    взглядами. Скрин (текст — постоянный маркер) после каждой из 13 РАЗНЫХ рук — не топтание; тикающий таймер
 *    Moodle в browser_read — не «прогресс» для долбёжки одной кнопки. screen_capture/input_click — НАСТОЯЩИЕ хендлеры.
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
const actual = (await vi.importActual<typeof import("../tools/dispatch.js")>("../tools/dispatch.js")).dispatchTool;

type Fake = (input: Record<string, unknown>) => ToolResult;
let fakes: Record<string, Fake> = {};
const okRes = (content: string, extra: Partial<ToolResult> = {}): ToolResult => ({ content, isError: false, ...extra });
const savedCap = process.env.JARVIS_TOOL_FAMILY_CAP;
const SITE = "https://courses.example/lesson/3";

beforeEach(() => {
  fakes = {};
  process.env.JARVIS_TOOL_FAMILY_CAP = "3";
  vi.mocked(dispatchTool).mockImplementation(async (name, input, ctx) => {
    const f = fakes[name];
    return f ? f((input ?? {}) as Record<string, unknown>) : actual(name, input, ctx);
  });
});
afterEach(() => {
  if (savedCap === undefined) delete process.env.JARVIS_TOOL_FAMILY_CAP;
  else process.env.JARVIS_TOOL_FAMILY_CAP = savedCap;
});

/**
 * Расширение: страница урока с идущим видео — текст тот же, тикает только плеер; снимок — каждый раз новый кадр.
 * tabCapture — как у настоящего моста (gateway/extension-bridge.ts): в ToolContext.ext он необязательный, в типе
 * AgentDeps.ext его нет, поэтому объект собирается переменной (без проверки лишних полей литерала).
 */
type Page = (tick: number) => { title: string; url: string; text: string; media?: Record<string, unknown> };
/** Урок с идущим видео: текст тот же, тикает только плеер. */
const LESSON: Page = (sec) => ({ title: "Урок 3", url: SITE, text: "Кнопка «Следующий урок» неактивна до конца видео.", media: { currentTime: sec, currentTimeLabel: `0:${String(sec).padStart(2, "0")}`, paused: false } });

function liveExt(page: Page = LESSON): NonNullable<AgentDeps["ext"]> {
  let sec = 0;
  let frame = 0;
  const ext = {
    connected: true,
    openOrFocus: vi.fn(async () => ({ focused: true, tabId: 5 })),
    tabRead: vi.fn(async () => page(++sec)),
    tabCapture: vi.fn(async () => {
      frame += 1;
      return { ok: true, dataUrl: `data:image/png;base64,${Buffer.from(`кадр видео ${frame}`).toString("base64")}`, width: 1280, height: 800, dpr: 1 };
    }),
    tabInspect: vi.fn(async () => ({ url: SITE, elements: [] })),
    tabAct: vi.fn(async () => ({ ok: true })),
    tabBatch: vi.fn(async () => ({ ok: true, done: 1, total: 1 })),
    tabList: vi.fn(async () => ({ tabs: [{ tabId: 5, url: SITE, status: "complete", active: true }] })),
    tabClose: vi.fn(async () => ({ closed: 0 })),
    exportCookies: vi.fn(async () => ({ cookies: [] })),
  };
  return ext;
}

const session = () => ({ sessionId: "s1", userId: "u1", sendAction: vi.fn(), send: vi.fn(), requestConfirm: vi.fn() }) as unknown as Session;
const deps = (llm: MockLlmProvider, page?: Page): AgentDeps => ({
  memory: new WorkingMemory(),
  llm,
  episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
  web: new MockWebProvider(),
  models: { haiku: "h", sonnet: "s", fable: "f" },
  spend: new SpendGuard(),
  userId: "u1",
  tasks: new TaskManager(),
  ext: liveExt(page),
});
const call = (id: string, name: string, input: Record<string, unknown>): MockTurn => ({ toolUses: [{ id, name, input }] });
const flood = (llm: MockLlmProvider): boolean => JSON.stringify(llm.requests).includes("топтание");

describe("LOOP-1: живая страница — не «прогресс» для долбёжки одной кнопки", () => {
  for (const [what, read] of [
    ["текст с тикающей позицией плеера", { url: SITE }],
    ["снимок вкладки (каждый кадр — новый base64)", { url: SITE, view: "image" }],
  ] as const) {
    it(`клик по той же кнопке + ${what} → нудж «топтание»`, async () => {
      fakes.browser_act = () => okRes("Сделал «click» в браузере. ВНИМАНИЕ: контент страницы НЕ изменился.");
      const turns: MockTurn[] = [];
      for (let n = 0; n < 8; n += 1) {
        turns.push(call(`c${n}`, "browser_act", { intent: "click", ref: "e1_7" }));
        turns.push(call(`r${n}`, "browser_read", { ...read }));
      }
      const llm = new MockLlmProvider(turns);
      await handleUserText(session(), "нажми следующий урок на сайте курса", deps(llm));
      const firstRead = JSON.stringify(llm.requests[2]?.messages ?? []);
      expect(firstRead).toMatch(read.view ? /Снимок вкладки браузера/u : /Плеер \(позиция из DOM/u); // фикстура дошла через хендлер
      expect(flood(llm)).toBe(true);
    });
  }
});

describe("LOOP-6: наведение/прокрутка — по сигнатуре цели", () => {
  it("scroll_to к полю → set в него, 8 разных полей: без нуджа «топтание» и без обрыва", async () => {
    fakes.browser_act = (i) => okRes(`Сделал «${String(i.intent)}» в браузере.`, i.intent === "set" ? { observed: true } : {});
    const turns: MockTurn[] = [];
    for (let n = 0; n < 8; n += 1) {
      turns.push(call(`s${n}`, "browser_act", { intent: "scroll_to", ref: `e1_${n}` }));
      turns.push(call(`v${n}`, "browser_act", { intent: "set", ref: `e1_${n}`, value: `ответ ${n}` }));
    }
    const llm = new MockLlmProvider([...turns, { text: "Все восемь полей анкеты заполнены, сэр." }, { text: "…" }]);
    const reply = await handleUserText(session(), "заполни анкету на сайте целиком", deps(llm));
    expect(flood(llm)).toBe(false);
    expect(reply.voice).toMatch(/восемь полей/u);
  });

  it("пинг-понг наведений на две цели (hover A, B, A, B…) — по-прежнему «топтание»", async () => {
    fakes.browser_act = () => okRes("Сделал «hover» в браузере.");
    const turns = Array.from({ length: 12 }, (_, n) => call(`h${n}`, "browser_act", { intent: "hover", ref: n % 2 ? "e1_5" : "e1_4" }));
    const llm = new MockLlmProvider(turns);
    await handleUserText(session(), "наведи на меню каталога на сайте", deps(llm));
    expect(flood(llm)).toBe(true);
  });
});

/** ПК владельца: клик по точке и скриншот — настоящие хендлеры (input_click, screen_capture), клиент подменён. */
function desktopSession(): Session {
  let frame = 0;
  const sendAction = vi.fn(async (cmd: { kind: string }) =>
    cmd.kind === "screen.capture"
      ? { commandId: "c", ok: true, data: { image: Buffer.from(`меню Доты, кадр ${++frame}`).toString("base64"), mediaType: "image/png" }, durationMs: 1 }
      : { commandId: "c", ok: true, durationMs: 1 },
  );
  return { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
}
const click = (id: string, x: number): MockTurn => call(id, "input_click", { target: { by: "coords", x, y: 300 }, method: "physical" });

describe("р2 loop-regress-2: скрин после РАЗНЫХ рук в UIA-слепом окне — не «тот же вид»", () => {
  it("13 разных кликов по меню Доты, скрин после каждого → без нуджа «топтание», до финала", async () => {
    const turns: MockTurn[] = [];
    for (let n = 0; n < 13; n += 1) turns.push(click(`c${n}`, 100 + 40 * n), call(`s${n}`, "screen_capture", {}));
    const llm = new MockLlmProvider([...turns, { text: "Графика в Доте настроена, сэр." }, { text: "…" }, { text: "…" }]);
    const reply = await handleUserText(desktopSession(), "настрой графику в доте на максимум", deps(llm));
    expect(JSON.stringify(llm.requests[2]?.messages ?? [])).toContain("Снимок рабочего экрана"); // скрин дошёл через хендлер
    expect(flood(llm)).toBe(false);
    expect(reply.voice).toMatch(/Графика в Доте настроена/u);
  });

  it("граница: долбёжка ОДНОЙ точки со скрином после каждого клика — «топтание» ловится", async () => {
    const turns: MockTurn[] = [];
    for (let n = 0; n < 8; n += 1) turns.push(click(`c${n}`, 100), call(`s${n}`, "screen_capture", {}));
    const llm = new MockLlmProvider(turns);
    await handleUserText(desktopSession(), "нажми играть в доте", deps(llm));
    expect(flood(llm)).toBe(true);
  });

  it("граница: та же галочка с readback + взгляд после каждого — цель уже видена, «топтание» ловится", async () => {
    fakes.browser_act = () => okRes("Сделал «set» в браузере.", { observed: true });
    const turns: MockTurn[] = [];
    for (let n = 0; n < 8; n += 1) turns.push(call(`v${n}`, "browser_act", { intent: "set", ref: "e1_4", checked: true }), call(`s${n}`, "screen_capture", {}));
    const llm = new MockLlmProvider(turns);
    await handleUserText(desktopSession(), "поставь галочку согласия на сайте", deps(llm));
    expect(flood(llm)).toBe(true);
  });
});

describe("р2 loop-tests-2: тикающий текст страницы — не «прогресс»", () => {
  /** Попытка теста в Moodle: вопрос тот же, тикает таймер попытки. */
  const QUIZ: Page = (t) => ({ title: "Тест: попытка", url: SITE, text: `Вопрос 3. Кнопка «Следующая страница» не нажимается. Оставшееся время 0:14:${String(59 - t).padStart(2, "0")}` });

  it("одна кнопка + browser_read с тикающим таймером Moodle → нудж «топтание»", async () => {
    fakes.browser_act = () => okRes("Сделал «click» в браузере.");
    const turns: MockTurn[] = [];
    for (let n = 0; n < 8; n += 1) turns.push(call(`c${n}`, "browser_act", { intent: "click", ref: "e1_7" }), call(`r${n}`, "browser_read", { url: SITE }));
    const llm = new MockLlmProvider(turns);
    await handleUserText(session(), "перейди на следующую страницу теста в мудле", deps(llm, QUIZ));
    expect(JSON.stringify(llm.requests[2]?.messages ?? [])).toMatch(/Оставшееся время 0:14:58/u); // текст дошёл через хендлер
    expect(flood(llm)).toBe(true);
  });
});

describe("р2 loop-tests-5: наведение на РАЗНЫЕ цели — не топтание", () => {
  it("hover по 8 разным ref (кап 3) → без нуджа", async () => {
    fakes.browser_act = () => okRes("Сделал «hover» в браузере.");
    const turns = Array.from({ length: 8 }, (_, n) => call(`h${n}`, "browser_act", { intent: "hover", ref: `e1_${n}` }));
    const llm = new MockLlmProvider([...turns, { text: "Навёл на все восемь пунктов меню, подсказки прочитаны, сэр." }, { text: "…" }]);
    await handleUserText(session(), "наведи по очереди на пункты меню каталога на сайте", deps(llm));
    expect(flood(llm)).toBe(false);
  });
});
