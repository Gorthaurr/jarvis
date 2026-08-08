/**
 * 🔴 Контроль-3 Ф0: тесты против РЕАЛЬНОЙ петли (`handleUserText`) на связку «§14-гейт остановил
 * действие».
 *
 * Почему отдельный файл против живой петли, а не юнит на функции: контроль-2 ввёл `gateStoppedRound`,
 * и он оказался МЁРТВЫМ КОДОМ (флаг сбрасывался в начале итерации — раньше, чем его читала
 * анти-капитуляция в следующем раунде). Прошли и typecheck, и все 1899 тестов: ни один не гонял
 * confirm-гейтнутый инструмент через петлю. Отсюда правило — проводку между механизмами проверяем
 * ПЕТЛЁЙ, а не только чистыми функциями.
 *
 * Что закрываем:
 *  1) после ОТКАЗА владельца петля не обвиняет модель в капитуляции (нет нуджа «не сдавайся») и не
 *     эскалирует тир «от гейта» — иначе владельца переспрашивают о том, на что он ответил «нет»;
 *  2) declined-вызов доходит до ЖУРНАЛА чекпойнта как «НЕ ВЫПОЛНЕНО» (не «ok»);
 *  3) реальная капитуляция БЕЗ гейта по-прежнему ловится (флаг не залипает).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, ConfirmRequest, ConfirmResult } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { type AgentDeps, handleUserText } from "./index.js";

type Outcome = "denied" | "expired" | "undelivered";

/** Сессия, чей §14-confirm отвечает заданным исходом (как настоящий Session.requestConfirm). */
function sessionWithConfirm(outcome: Outcome) {
  const sendAction = vi.fn((_cmd: ActionCommand, _t?: number) =>
    Promise.resolve({ commandId: "c", ok: true, durationMs: 1 }),
  );
  const requestConfirm = vi.fn(
    (req: ConfirmRequest): Promise<ConfirmResult> =>
      Promise.resolve({ requestId: req.requestId, approved: false, outcome }),
  );
  return { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm } as unknown as Session & {
    requestConfirm: typeof requestConfirm;
  };
}

async function deps(llm: MockLlmProvider, over: Partial<AgentDeps> = {}): Promise<AgentDeps> {
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

/** Скрипт: раунд 1 — необратимое действие под гейтом; раунд 2 — модель честно говорит «не могу». */
const giveUpAfterGate = () =>
  new MockLlmProvider([
    { toolUses: [{ id: "d1", name: "fs_delete", input: { path: "C:/Users/anton/Downloads", recursive: true } }] },
    { text: "Не могу удалить папку без вашего подтверждения, сэр." },
    { text: "Не могу удалить папку без вашего подтверждения, сэр." },
  ]);

const nudged = (llm: MockLlmProvider): boolean =>
  llm.requests.some((r) => JSON.stringify(r.messages).includes("запрещённый ответ"));

describe("§14-гейт остановил действие — это НЕ капитуляция модели (контроль-3)", () => {
  it("ОТКАЗ владельца: нет нуджа «не сдавайся» и нет эскалации тира «от гейта»", async () => {
    const llm = giveUpAfterGate();
    await handleUserText(sessionWithConfirm("denied"), "почисти папку загрузок", await deps(llm));
    expect(nudged(llm)).toBe(false); // до фикса: нудж уходил, и владельца переспрашивали
    expect(llm.requests.every((r) => r.model !== "f")).toBe(true); // и жгли Opus «от гейта»
    expect(llm.requests.length).toBeLessThanOrEqual(2); // лишнего круга нет
  });

  it("ИСТЁКШЕЕ окно: то же самое (владелец просто не ответил)", async () => {
    const llm = giveUpAfterGate();
    await handleUserText(sessionWithConfirm("expired"), "почисти папку загрузок", await deps(llm));
    expect(nudged(llm)).toBe(false);
    expect(llm.requests.every((r) => r.model !== "f")).toBe(true);
  });

  it("капитуляция БЕЗ гейта по-прежнему ловится (флаг не залипает и не глушит защиту)", async () => {
    // Ни одного confirm-гейтнутого вызова: нейтральный поиск, затем «сдаюсь словами».
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "w1", name: "web_search", input: { query: "как удалить" } }] },
      { text: "Не могу это сделать." },
      { text: "Хорошо, попробую иначе." },
      { text: "Готово." },
    ]);
    await handleUserText(sessionWithConfirm("denied"), "разберись с задачей", await deps(llm));
    expect(nudged(llm)).toBe(true); // защита от «погуглил и сдался» жива
  });
});

describe("declined доходит до журнала чекпойнта через ПЕТЛЮ (контроль-3)", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-gate-cp-"));
    process.env.JARVIS_CONTEXT_SOFT_TOKENS = "20000";
    process.env.JARVIS_CONTEXT_HARD_TOKENS = "30000";
  });
  afterEach(() => {
    delete process.env.JARVIS_CONTEXT_SOFT_TOKENS;
    delete process.env.JARVIS_CONTEXT_HARD_TOKENS;
    rmSync(dir, { recursive: true, force: true });
  });

  it("прерванная задача: отклонённое действие в журнале — «НЕ ВЫПОЛНЕНО», а не «ok»", async () => {
    const checkpoints = new CheckpointStore(dir);
    // Раунд 1 — declined fs_delete; раунд 2 — огромный usage упирает в HARD-порог → чекпойнт.
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "d1", name: "fs_delete", input: { path: "C:/tmp/junk", recursive: true } }] },
      { toolUses: [{ id: "w1", name: "web_search", input: { query: "x" } }], usage: { inputTokens: 50_000 } },
      { text: "не должно вызваться" },
    ]);
    await handleUserText(sessionWithConfirm("denied"), "почисти мусор и собери отчёт", await deps(llm, { checkpoints }));
    const cp = checkpoints.peek("u1");
    expect(cp).not.toBeNull();
    expect(cp?.digest).toContain("НЕ ВЫПОЛНЕНО"); // ← без проводки declinedCalls тут было бы «— ok»
    expect(cp?.digest).not.toMatch(/fs_delete\([^)]*\) — ok/);
  });
});
