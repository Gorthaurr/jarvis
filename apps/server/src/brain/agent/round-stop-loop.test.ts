/**
 * W2 (П4, G-8): СТОП РАУНДА — петлёй (`handleUserText`), не чистой функцией.
 *
 * Модель шлёт раунд вслепую: [act type «Поиск», act key Enter]. Первый шаг не нашёл поле → Enter НЕ уходит (иначе он
 * жмётся в чужом поле/чате). Вместо него — заглушка «не исполнен», в журнале «НЕ ИСПОЛНЯЛСЯ» (не «ОШИБКА»), а §7 не
 * считает заглушку ошибкой модели. Чтение после провала исполняется; §14-отказ тоже останавливает мутации раунда.
 * Реверт-проверка: `node scripts/mutate-loop.cjs round-stop` (skipAfterStop выключен) — падают 1, 2, 3;
 * `round-stop-count-stub` (заглушка считается в roundErrors) — падает 4.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult, ConfirmRequest, ConfirmResult } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { type LlmMessage, MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { type AgentDeps, handleUserText } from "./index.js";

type Reply = (cmd: ActionCommand) => Omit<ActionResult, "commandId" | "durationMs">;

/** Сессия: ответ клиента по виду команды; журнал ушедших команд — то, что РЕАЛЬНО дошло бы до ПК. */
function session(reply: Reply, confirm: ConfirmResult["outcome"] = "approved") {
  const sent: ActionCommand[] = [];
  const sendAction = vi.fn((cmd: ActionCommand) => {
    sent.push(cmd);
    return Promise.resolve({ commandId: "c", durationMs: 1, ...reply(cmd) });
  });
  const requestConfirm = vi.fn((req: ConfirmRequest): Promise<ConfirmResult> => Promise.resolve({ requestId: req.requestId, approved: confirm === "approved", outcome: confirm }));
  return { s: { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm } as unknown as Session, sent };
}

const notFound: Reply = (cmd) =>
  cmd.kind === "gui.act" && cmd.do === "type"
    ? { ok: false, error: { code: "not_found", message: "Цель «Поиск» не найдена ни в UIA-снапшоте, ни OCR." } }
    : cmd.kind === "screen.capture"
      ? { ok: true, data: { image: "iVBORw0KGgo=", mediaType: "image/png" } }
      : { ok: true, data: { did: "нажал «Enter»", verified: "unchecked" } };

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

const typeSearch = { id: "t1", name: "act", input: { target: "Поиск", do: "type", text: "Катя", app: "Telegram" } };
const enter = { id: "k1", name: "act", input: { do: "key", combo: "Enter", app: "Telegram" } };

/** tool_result второго запроса к модели (ответ на первый раунд) по id. */
function resultOf(llm: MockLlmProvider, id: string): { content: unknown; is_error?: boolean } | undefined {
  for (const m of llm.requests[1]?.messages ?? ([] as LlmMessage[])) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_result" && b.tool_use_id === id) return b;
  }
  return undefined;
}

describe("стоп раунда после провала мутации (G-8)", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-round-stop-"));
    process.env.JARVIS_CONTEXT_SOFT_TOKENS = "20000";
    process.env.JARVIS_CONTEXT_HARD_TOKENS = "30000";
  });
  afterEach(() => {
    delete process.env.JARVIS_CONTEXT_SOFT_TOKENS;
    delete process.env.JARVIS_CONTEXT_HARD_TOKENS;
    rmSync(dir, { recursive: true, force: true });
  });

  it("[act type «Поиск» → not_found, act key Enter] → в сессию ушла ОДНА gui.act; второй результат «не исполнен»; журнал «НЕ ИСПОЛНЯЛСЯ»", async () => {
    const checkpoints = new CheckpointStore(dir);
    const llm = new MockLlmProvider([
      { toolUses: [typeSearch, enter] },
      // Раунд 2 раздувает контекст → задача прерывается с журналом (так журнал доступен тесту).
      { toolUses: [{ id: "w1", name: "web_search", input: { query: "x" } }], usage: { inputTokens: 50_000 } },
      { text: "не должно вызваться" },
    ]);
    const { s, sent } = session(notFound);
    await handleUserText(s, "напиши Кате в телеграме", deps(llm, { checkpoints }));
    expect(sent.filter((c) => c.kind === "gui.act")).toHaveLength(1); // до фикса — две: Enter жался вслепую
    expect(sent.find((c) => c.kind === "gui.act" && c.do === "key")).toBeUndefined();
    const second = resultOf(llm, "k1");
    expect(second?.is_error).toBe(true);
    expect(String(second?.content)).toMatch(/НЕ ИСПОЛНЕН/u);
    const cp = checkpoints.peek("u1");
    expect(cp?.digest).toMatch(/act\([^)]*combo=Enter[^)]*\) — НЕ ИСПОЛНЯЛСЯ/u);
    expect(cp?.digest).not.toMatch(/act\([^)]*combo=Enter[^)]*\) — ОШИБКА/u); // «ОШИБКА» = попытка, «доделай» повторил бы её как есть
    expect(cp?.digest).toMatch(/act\([^)]*text=Катя[^)]*\) — ОШИБКА/u); // сам провал — честно ошибкой
  });

  it("[act fail, screen_capture] → снимок после провала ИСПОЛНЕН (стоп касается только мутаций)", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [typeSearch, { id: "c1", name: "screen_capture", input: {} }] },
      { text: "Поле поиска не нашлось, сэр." },
      { text: "Поле поиска не нашлось, сэр." },
    ]);
    const { s, sent } = session(notFound);
    await handleUserText(s, "напиши Кате в телеграме", deps(llm));
    expect(sent.map((c) => c.kind)).toEqual(["gui.act", "screen.capture"]);
    expect(resultOf(llm, "c1")?.is_error).toBe(false);
  });

  it("[fs_delete отклонён владельцем (§14), act click] → act НЕ исполнен: отказ — тоже стоп раунда", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "d1", name: "fs_delete", input: { path: "C:/Users/anton/Downloads/x.txt" } }, { id: "a1", name: "act", input: { target: "Очистить корзину" } }] },
      { text: "Не стал удалять без вашего подтверждения, сэр." },
      { text: "Не стал удалять без вашего подтверждения, сэр." },
    ]);
    const { s, sent } = session(notFound, "denied");
    await handleUserText(s, "удали файл и очисти корзину", deps(llm));
    expect(sent.filter((c) => c.kind === "gui.act" || c.kind === "fs.delete")).toEqual([]);
    expect(String(resultOf(llm, "a1")?.content)).toMatch(/НЕ ИСПОЛНЕН/u);
  });

  it("§7: [act под вуалью, act key] ×2 — заглушка НЕ ошибка модели: раунд остаётся «вуальным», эскалации на fable нет", async () => {
    const veil: Reply = (cmd) =>
      cmd.kind === "gui.act" && cmd.do === "type"
        ? { ok: false, error: { code: "overlay_drawing", message: "Поверх экрана открыт оверлей режима выделения" } }
        : { ok: true, data: { verified: "unchecked" } };
    const round = (n: number) => ({ toolUses: [{ ...typeSearch, id: `t${n}` }, { ...enter, id: `k${n}` }] });
    const llm = new MockLlmProvider([round(1), round(2), { text: "Дождусь, пока закроется оверлей, сэр." }]);
    const { s, sent } = session(veil);
    await handleUserText(s, "напиши Кате в телеграме", deps(llm));
    expect(sent.filter((c) => c.kind === "gui.act" && c.do === "key")).toEqual([]);
    // Засчитай заглушку ошибкой — вуаль перестала бы быть «единственной ошибкой раунда», и §7 увёл бы задачу на fable.
    expect(llm.requests.every((r) => r.model !== "f")).toBe(true);
  });
});
