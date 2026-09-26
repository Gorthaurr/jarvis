/**
 * W1 (B-4) — ПРОВОДКА честного исхода браузерных рук из хендлера в ПЕТЛЮ и журнал чекпойнта: настоящий
 * `handleUserText`, настоящий dispatch/handlers/browser, настоящий `CheckpointStore`; подменены только рубежи в
 * другом процессе — расширение (`deps.ext`, его ошибки — ровно те, что бросает мост) и клиент (`sendAction`).
 *
 * 🔴 КАКОЙ ДЕФЕКТ ОХРАНЯЕМ. Расширение не ответило ПОСЛЕ отправки клика «Оформить заказ» (таймаут моста / разрыв).
 * Раньше хендлер звал это «Не вышло» и открывал координатный хатч; журнал прерванной задачи писал «ОШИБКА» =
 * «не сделано», и «доделай» жало кнопку второй раз — второй заказ. Теперь хендлер отдаёт `uncertain`, петля кладёт
 * вызов в uncertainCalls, журнал говорит «ИСХОД НЕИЗВЕСТЕН — СВЕРЬ». Частично прошедший берст — «ЧАСТИЧНО», не «ОШИБКА».
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult, ConfirmRequest, ConfirmResult } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { extNoReplyError } from "../tools/ext-errors.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { type AgentDeps, handleUserText } from "./index.js";

const SITE = "https://shop.example/cart";

function ownerSession(userId: string): Session {
  const sendAction = vi.fn((_cmd: ActionCommand) => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 } as ActionResult));
  const requestConfirm = vi.fn((req: ConfirmRequest): Promise<ConfirmResult> => Promise.resolve({ requestId: req.requestId, approved: true, outcome: "approved" }));
  return { sessionId: `s-${userId}`, userId, sendAction, send: vi.fn(), requestConfirm } as unknown as Session;
}

/** Расширение: вкладка магазина открыта; поведение tab.act / tab.batch задаёт тест. */
function extWith(over: { tabAct?: () => Promise<unknown>; tabBatch?: () => Promise<unknown> }): NonNullable<AgentDeps["ext"]> {
  return {
    connected: true,
    openOrFocus: vi.fn(async () => ({ focused: true, tabId: 5 })),
    tabRead: vi.fn(async () => ({})),
    tabInspect: vi.fn(async () => ({ url: SITE, elements: [] })),
    tabAct: vi.fn(over.tabAct ?? (async () => ({ ok: true }))),
    tabBatch: vi.fn(over.tabBatch ?? (async () => ({ ok: true, done: 1, total: 1 }))),
    tabList: vi.fn(async () => ({ tabs: [{ tabId: 5, url: SITE, status: "complete", active: true }] })),
    tabClose: vi.fn(async () => ({ closed: 0 })),
    exportCookies: vi.fn(async () => ({ cookies: [] })),
  };
}

/** Раунд, упирающий проекцию промпта в HARD-порог → петля прерывается и ПИШЕТ журнал (как send-outcome-loop). */
const WRAP_ROUND = { toolUses: [{ id: "w1", name: "web_search", input: { query: "цены" } }], usage: { inputTokens: 50_000 } };

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-browser-outcome-"));
  process.env.JARVIS_CONTEXT_SOFT_TOKENS = "20000";
  process.env.JARVIS_CONTEXT_HARD_TOKENS = "30000";
});
afterEach(() => {
  delete process.env.JARVIS_CONTEXT_SOFT_TOKENS;
  delete process.env.JARVIS_CONTEXT_HARD_TOKENS;
  rmSync(dir, { recursive: true, force: true });
});

async function digestAfter(userId: string, firstRound: { id: string; name: string; input: Record<string, unknown> }, ext: NonNullable<AgentDeps["ext"]>): Promise<string> {
  const checkpoints = new CheckpointStore(dir);
  const llm = new MockLlmProvider([{ toolUses: [firstRound] }, WRAP_ROUND, { text: "не должно вызваться" }]);
  const deps: AgentDeps = {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId,
    tasks: new TaskManager(),
    checkpoints,
    ext,
  };
  await handleUserText(ownerSession(userId), "оформи заказ в корзине магазина и собери цены", deps);
  const digest = checkpoints.peek(userId)?.digest;
  expect(digest, "чекпойнт не записан").toBeTruthy();
  return digest!;
}

describe("W1: исход браузерных рук доходит до журнала прерванной задачи", () => {
  it("клик без ответа расширения → «ИСХОД НЕИЗВЕСТЕН — СВЕРЬ», а не «ОШИБКА» (доделай не нажмёт второй раз)", async () => {
    const ext = extWith({
      tabAct: async () => {
        throw extNoReplyError("расширение не ответило за 20000мс");
      },
    });
    const digest = await digestAfter("u-browser-uncertain", { id: "b1", name: "browser_act", input: { url: SITE, intent: "click", ref: "e1_3" } }, ext);
    const line = digest.split("\n").find((l) => l.includes("browser_act(")) ?? "";
    expect(line).toContain("ИСХОД НЕИЗВЕСТЕН");
    expect(line).not.toContain("ОШИБКА");
  }, 20_000);

  it("берст остановился на 2-м шаге из 3 → «ЧАСТИЧНО — шаги 1..1 УЖЕ ВЫПОЛНЕНЫ», а не «ОШИБКА» (повтор не наберёт текст дважды)", async () => {
    const ext = extWith({ tabBatch: async () => ({ ok: false, code: "not_found", done: 1, total: 3, stoppedAt: 1, error: "нет элемента" }) });
    const digest = await digestAfter(
      "u-browser-partial",
      { id: "b2", name: "browser_batch", input: { url: SITE, steps: [{ ref: "e1_0", intent: "type", params: { text: "Антон" } }, { ref: "e1_1", intent: "click" }, { ref: "e1_2", intent: "click" }] } },
      ext,
    );
    const line = digest.split("\n").find((l) => l.includes("browser_batch(")) ?? "";
    expect(line).toContain("ЧАСТИЧНО");
    expect(line).toContain("1..1");
    expect(line).not.toContain("ОШИБКА");
  }, 20_000);
});
