/**
 * Ревью 2026-09-24 (T-F7): все попытки действия провалились, модель ЧЕСТНО сказала «не выполнено» → это провал.
 *
 * Было: содержательная честная фраза проходит мимо masked-failure (тот ловит только полое «Готово»), и ход писался
 * ok:true / state:done — в метриках и самодиагностике провал выглядел успехом. Реплику модели терминал НЕ подменяет:
 * она честная, меняется только ЗАПИСЬ об исходе. Проверяем петлёй: метрики задачи + состояние в реестре.
 * Реверт-проверка: убери `&& !mutationsAllFailed` из taskOk (loop/outcome.ts) и tasks.fail в runAgentLoop — первый
 * тест упадёт (ok:true, state:done).
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
import { metrics } from "../../obs/metrics.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

const HONEST = "Записать файл не получилось, сэр: диск отказал в доступе. Задача не выполнена.";

function setup(writeOk: boolean) {
  const sendAction = vi.fn((cmd: ActionCommand) =>
    Promise.resolve(
      cmd.kind === "fs.write" && !writeOk
        ? { commandId: "c", ok: false, error: { code: "denied" as const, message: "Отказано в доступе" }, durationMs: 1 }
        : { commandId: "c", ok: true, durationMs: 1 },
    ),
  );
  const session = { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
  const write = { toolUses: [{ id: `w${Math.random()}`, name: "fs_write", input: { path: "C:/Users/anton/Desktop/отчёт.txt", content: "итоги" } }] };
  // Две попытки записи, дальше модель честно сдаётся (с запасом на нуджи анти-капитуляции/goal-check).
  const llm = new MockLlmProvider([
    write,
    { toolUses: [{ id: "w2", name: "fs_write", input: { path: "C:/Users/anton/Desktop/отчёт2.txt", content: "итоги" } }] },
    ...Array.from({ length: 8 }, () => ({ text: writeOk ? "Записал отчёт на рабочий стол, сэр." : HONEST })),
  ]);
  const tasks = new TaskManager();
  const deps: AgentDeps = {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks,
  };
  return { session, deps, tasks };
}

describe("T-F7: все мутации провалились → провал в метриках и реестре, реплика модели — как есть", () => {
  it("fs_write с ошибкой ×2 + честное «не выполнено» → metrics ok:false, задача failed, фраза модели не подменена", async () => {
    const records: Array<{ ok: boolean }> = [];
    const spy = vi.spyOn(metrics, "record").mockImplementation((e) => void records.push(e));
    try {
      const { session, deps, tasks } = setup(false);
      const reply = await handleUserText(session, "запиши итоги в файл на рабочий стол", deps);
      expect(records.at(-1)?.ok).toBe(false);
      const [task] = tasks.list("u1");
      expect(task?.state).toBe("failed");
      expect(reply.voice).toContain("диск отказал"); // честный текст модели звучит как есть
    } finally {
      spy.mockRestore();
    }
  });

  it("обратная полярность: запись удалась → ok:true, done (тест ловит дыру, а не «всё провалено»)", async () => {
    const records: Array<{ ok: boolean }> = [];
    const spy = vi.spyOn(metrics, "record").mockImplementation((e) => void records.push(e));
    try {
      const { session, deps, tasks } = setup(true);
      await handleUserText(session, "запиши итоги в файл на рабочий стол", deps);
      expect(records.at(-1)?.ok).toBe(true);
      expect(tasks.list("u1")[0]?.state).toBe("done");
    } finally {
      spy.mockRestore();
    }
  });
});
