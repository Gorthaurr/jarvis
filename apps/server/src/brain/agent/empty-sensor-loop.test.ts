/**
 * Пустой сенсор НЕ снимает verify-долг — проверяется ПЕТЛЁЙ (правило аудита тестовой базы).
 *
 * 🔴 Корень (ревью ядра 2026-09-01): `realVerify` определялся одним лишь КЛАССОМ инструмента
 * (`eff === "verify"`), без взгляда на то, вернул ли сенсор хоть что-нибудь. UIA-слепое окно
 * (игра, canvas) отдаёт `items: []` БЕЗ ошибки — и такой «взгляд» гасил и обычный verify-долг, и
 * долг сверки отправки. Дыра тем опаснее, что именно на слепых окнах сверка и нужна: соседний
 * fused-путь ровно то же пустое наблюдение считает слабым (`weak`) и долг не снимает.
 *
 * Проверять чистой функцией нельзя: дефект — в ПРОВОДКЕ (dispatch ставит `empty`, петля его
 * читает). Ровно тот класс, на котором проект уже обжигался («мёртвый фикс» gateStoppedRound).
 *
 * Реверт-проверка (прогнана): возврат `const realVerify = eff === "verify"` роняет первый кейс.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

/** Сессия, где ui.snapshot отдаёт ЗАДАННЫЙ набор элементов, а остальное — обычный ok. */
function sessionWithSnapshot(items: unknown[]) {
  const sendAction = vi.fn((cmd: ActionCommand) =>
    Promise.resolve(
      cmd.kind === "ui.snapshot"
        ? { commandId: "c", ok: true, data: { items }, durationMs: 1 }
        : { commandId: "c", ok: true, durationMs: 1 },
    ),
  );
  return { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
}

async function deps(llm: MockLlmProvider): Promise<AgentDeps> {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks: new TaskManager(),
  };
}

/** Слепой клик → «сверка» снапшотом → заявление результата. */
const clickThenSnapshotThenClaim = () =>
  new MockLlmProvider([
    { toolUses: [{ id: "c1", name: "input_click", input: { by: "coords", x: 100, y: 200 } }] },
    { toolUses: [{ id: "s1", name: "ui_snapshot", input: {} }] },
    { text: "Готово, сэр — кнопка нажата." },
    { text: "Готово, сэр — кнопка нажата." },
    { text: "Готово, сэр — кнопка нажата." },
  ]);

/** Ушёл ли в модель нудж «сверь исход» (значит verify-долг остался висеть). */
const verifyNudged = (llm: MockLlmProvider): boolean =>
  llm.requests.some((r) => JSON.stringify(r.messages).includes("НЕ проверил исход"));

describe("пустой сенсор ≠ сверка исхода (проводка dispatch → петля)", () => {
  it("ui_snapshot вернул items:[] — verify-долг ОСТАЁТСЯ, петля требует сверки", async () => {
    const llm = clickThenSnapshotThenClaim();
    await handleUserText(sessionWithSnapshot([]), "нажми кнопку играть", await deps(llm));
    expect(verifyNudged(llm)).toBe(true);
  });

  it("ui_snapshot вернул элементы — долг снят, лишнего нуджа нет", async () => {
    const llm = clickThenSnapshotThenClaim();
    await handleUserText(
      sessionWithSnapshot([{ handle: 1, role: "Button", name: "Играть" }]),
      "нажми кнопку играть",
      await deps(llm),
    );
    expect(verifyNudged(llm)).toBe(false);
  });
});
