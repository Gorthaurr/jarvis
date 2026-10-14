import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { dispatchFileCommand } from "../../../../client/main/actuators/fs-dispatch.js";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { dispatchTool, type ToolContext } from "../tools/dispatch.js";
import { toolCallEffect } from "./error-voice.js";
import { type AgentDeps, handleUserText } from "./index.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "jarvis-undo-loop-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function session() {
  const sendAction = vi.fn(async (cmd: ActionCommand): Promise<ActionResult> => {
    try { return { commandId: "c", ok: true, durationMs: 1, data: await dispatchFileCommand(cmd) }; }
    catch (error) { return { commandId: "c", ok: false, durationMs: 1, error: { code: "runtime", message: String(error) } }; }
  });
  return { sessionId: "undo-s", userId: "undo-u", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
}

function deps(llm: MockLlmProvider): AgentDeps {
  return { memory: new WorkingMemory(), llm, episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(), models: { haiku: "h", sonnet: "s", fable: "f" }, spend: new SpendGuard(),
    userId: "undo-u", tasks: new TaskManager(), devSession: true, toolActivation: new Set() };
}

describe("undo проходит из агентной петли до настоящих байтов файла", () => {
  it("модель видит инструмент, загружает его, выбирает снимок, восстанавливает и перечитывает файл", async () => {
    const path = join(dir, "notes.txt");
    const before = Buffer.from("\uFEFFПрежнее содержимое\r\n", "utf8");
    await writeFile(path, before);
    const change = await dispatchFileCommand({ kind: "fs.write", path, content: "Изменено" }) as { undoId: string };
    expect(change.undoId).toBeTruthy();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "load", name: "tool_load", input: { names: ["fs_undo"] } }] },
      { toolUses: [{ id: "list", name: "fs_undo", input: { op: "list" } }] },
      { toolUses: [{ id: "restore", name: "fs_undo", input: { op: "restore", id: change.undoId, content: "forged" } }] },
      { toolUses: [{ id: "read", name: "fs_read", input: { path } }] },
      { text: "Восстановил прежнее содержимое файла и проверил его." },
    ]);
    const s = session();
    await handleUserText(s, `Восстанови прежнее содержимое файла ${path}`, deps(llm));
    expect(await readFile(path)).toEqual(before);
    const sent = vi.mocked(s.sendAction).mock.calls.map(([cmd]) => cmd);
    expect(sent).toContainEqual(expect.objectContaining({ kind: "fs.undo", op: "restore", id: change.undoId }));
    expect(sent.find((cmd) => cmd.kind === "fs.undo" && cmd.op === "restore")).not.toHaveProperty("content");
    expect(String(llm.requests[0]?.systemTools)).toContain("fs_undo");
    expect(llm.requests.some((req) => req.tools?.some((tool) => tool.name === "fs_undo"))).toBe(true);
  });

  it("внешняя правка возвращает ошибку модели, не затирается и не считается успехом", async () => {
    const path = join(dir, "changed.txt");
    await writeFile(path, "исходник");
    const change = await dispatchFileCommand({ kind: "fs.write", path, content: "правка Jarvis" }) as { undoId: string };
    await writeFile(path, "новая правка владельца");
    const result = await dispatchTool("fs_undo", { op: "restore", id: change.undoId },
      { userId: "undo-u", session: session() } as unknown as ToolContext);
    expect(result.isError).toBe(true);
    expect(await readFile(path, "utf8")).toBe("новая правка владельца");
    expect(toolCallEffect("fs_undo", { op: "list" })).toBe("neutral");
    expect(toolCallEffect("fs_undo", { op: "restore", id: change.undoId })).toBe("mutate");
  });
});
