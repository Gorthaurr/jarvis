/**
 * W1-LOOP-4 — ПРОВОДКА через настоящий `handleUserText`: две задачи ОДНОЙ сессии идут внахлёст (browser_act без аренды
 * ввода с W1). Задача A открыла вкладку 7 и «думает»; задача B в это время действует во вкладке 9. Следующий неявный
 * browser_act задачи A обязан уйти в ЕЁ вкладку 7, а не в последнюю выбранную сессией (раньше цель была одна на сессию).
 * Подменены только рубежи в другом процессе: расширение (`deps.ext`), клиент (`sendAction`) и модель (скрипт по раундам).
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult, ConfirmRequest, ConfirmResult } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider, type LlmRequest, type LlmResponse } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "../agent/index.js";

const SITE = "https://shop.example/catalog";

/** Модель, чей второй раунд ждёт внешнего сигнала — так задача B успевает вклиниться между раундами задачи A. */
class GatedLlm extends MockLlmProvider {
  private n = 0;
  constructor(script: ConstructorParameters<typeof MockLlmProvider>[0], private readonly gate: Promise<void>) {
    super(script);
  }
  override async complete(req: LlmRequest): Promise<LlmResponse> {
    if (this.n++ === 1) await this.gate;
    return super.complete(req);
  }
}

function depsFor(llm: MockLlmProvider, ext: NonNullable<AgentDeps["ext"]>): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u-target",
    tasks: new TaskManager(),
    ext,
  };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

describe("W1-LOOP-4: цель вкладки у каждой задачи своя", () => {
  it("неявный browser_act задачи A идёт в её вкладку, хотя задача B сессии между раундами выбрала другую", async () => {
    const sendAction = vi.fn((_cmd: ActionCommand) => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 } as ActionResult));
    const requestConfirm = vi.fn((req: ConfirmRequest): Promise<ConfirmResult> => Promise.resolve({ requestId: req.requestId, approved: true, outcome: "approved" }));
    const session = { sessionId: "s-target", userId: "u-target", sendAction, send: vi.fn(), requestConfirm } as unknown as Session;
    const ext: NonNullable<AgentDeps["ext"]> = {
      connected: true,
      openOrFocus: vi.fn(async () => ({ focused: false, tabId: 7 })),
      tabRead: vi.fn(async () => ({})),
      tabInspect: vi.fn(async () => ({ url: SITE, elements: [] })),
      tabAct: vi.fn(async () => ({ ok: true, playing: true })),
      tabList: vi.fn(async () => ({ tabs: [] })),
      tabClose: vi.fn(async () => ({ closed: 0 })),
      exportCookies: vi.fn(async () => ({ cookies: [] })),
    };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const llmA = new GatedLlm(
      [
        { toolUses: [{ id: "a1", name: "browser_open", input: { url: SITE } }] },
        { toolUses: [{ id: "a2", name: "browser_act", input: { intent: "play", ref: "e1_2" } }] },
        { text: "Включил." },
      ],
      gate,
    );
    const llmB = new MockLlmProvider([{ toolUses: [{ id: "b1", name: "browser_act", input: { tabId: 9, intent: "pause", ref: "e1_1" } }] }, { text: "Поставил на паузу." }]);

    const taskA = handleUserText(session, "открой каталог магазина и включи первое видео", depsFor(llmA, ext));
    await until(() => vi.mocked(ext.openOrFocus).mock.calls.length > 0);
    await handleUserText(session, "поставь на паузу видео во вкладке 9", depsFor(llmB, ext));
    expect(vi.mocked(ext.tabAct).mock.calls[0]?.[3]).toBe(9);
    release();
    await taskA;
    await until(() => vi.mocked(ext.tabAct).mock.calls.length >= 2);
    const aCall = vi.mocked(ext.tabAct).mock.calls.find((c) => c[1] === "play");
    expect(aCall?.[3]).toBe(7);
  }, 20_000);
});

/** Сессия + расширение: browser_open отдаёт вкладку по адресу (магазин → 7, почта → 9), tab.act записывает цель. */
function world(): { session: Session; ext: NonNullable<AgentDeps["ext"]> } {
  const sendAction = vi.fn((_cmd: ActionCommand) => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 } as ActionResult));
  const requestConfirm = vi.fn((req: ConfirmRequest): Promise<ConfirmResult> => Promise.resolve({ requestId: req.requestId, approved: true, outcome: "approved" }));
  const session = { sessionId: "s-target-r2", userId: "u-target", sendAction, send: vi.fn(), requestConfirm } as unknown as Session;
  const ext: NonNullable<AgentDeps["ext"]> = {
    connected: true,
    openOrFocus: vi.fn(async (url: string) => ({ focused: false, tabId: url.includes("mail") ? 9 : 7 })),
    tabRead: vi.fn(async () => ({})),
    tabInspect: vi.fn(async () => ({ url: SITE, elements: [] })),
    tabAct: vi.fn(async () => ({ ok: true })),
    tabList: vi.fn(async () => ({ tabs: [] })),
    tabClose: vi.fn(async () => ({ closed: 0 })),
    exportCookies: vi.fn(async () => ({ cookies: [] })),
  };
  return { session, ext };
}
const MAIL = "https://mail.example/inbox";

describe("Р2 srv-tests-3/4: задача закрепляет цель вкладки за собой", () => {
  it("задача-продолжение без своей цели: первый неявный вызов закрепляет цель сессии, чужой browser_open её не уводит", async () => {
    const { session, ext } = world();
    // Реплика 1: открыла вкладку 7 и закончилась — цель осталась только у сессии.
    await handleUserText(session, "зайди на сайт магазина и найди там каталог видео", depsFor(new MockLlmProvider([{ toolUses: [{ id: "t1", name: "browser_open", input: { url: SITE } }] }, { text: "Открыл." }]), ext));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Реплика 2 (продолжение): наведение без url/tabId, между раундами — «думает».
    const llmA = new GatedLlm(
      [
        { toolUses: [{ id: "a1", name: "browser_act", input: { intent: "hover", ref: "e1_2" } }] },
        { toolUses: [{ id: "a2", name: "browser_act", input: { intent: "click", text: "Первое видео" } }] },
        { text: "Кликнул." },
      ],
      gate,
    );
    const taskA = handleUserText(session, "наведи на первое видео каталога и кликни по нему", depsFor(llmA, ext));
    await until(() => vi.mocked(ext.tabAct).mock.calls.length > 0);
    // Параллельная задача той же сессии открыла почту (вкладка 9).
    await handleUserText(session, "проверь, что во входящих почты", depsFor(new MockLlmProvider([{ toolUses: [{ id: "b1", name: "browser_open", input: { url: MAIL } }] }, { text: "Открыл почту." }]), ext));
    expect(vi.mocked(ext.openOrFocus).mock.calls.map((c) => c[0])).toEqual([SITE, MAIL]);
    release();
    await taskA;
    await until(() => vi.mocked(ext.tabAct).mock.calls.length >= 2);
    expect(vi.mocked(ext.tabAct).mock.calls.map((c) => [c[1], c[3]])).toEqual([["hover", 7], ["click", 7]]);
  }, 20_000);

  it("явный tabId задачи закрепляется за НЕЙ: чужой browser_open между раундами не уводит её неявный act", async () => {
    const { session, ext } = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const llmA = new GatedLlm(
      [
        { toolUses: [{ id: "a1", name: "browser_read", input: { tabId: 5 } }] },
        { toolUses: [{ id: "a2", name: "browser_act", input: { intent: "click", ref: "e1_2" } }] },
        { text: "Нажал." },
      ],
      gate,
    );
    const taskA = handleUserText(session, "прочитай вкладку 5 и нажми там первую кнопку", depsFor(llmA, ext));
    await until(() => vi.mocked(ext.tabRead).mock.calls.length > 0);
    await handleUserText(session, "проверь, что во входящих почты", depsFor(new MockLlmProvider([{ toolUses: [{ id: "b1", name: "browser_open", input: { url: MAIL } }] }, { text: "Открыл почту." }]), ext));
    release();
    await taskA;
    await until(() => vi.mocked(ext.tabAct).mock.calls.length >= 1);
    expect(vi.mocked(ext.tabAct).mock.calls[0]?.[3]).toBe(5);
  }, 20_000);
});
