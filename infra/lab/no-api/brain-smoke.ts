/** Живой LLM + настоящий gateway/loop, виртуальный ПК. Никаких действий на рабочем столе владельца. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startLabServer } from "../lib/server.js";
import { connectLabClient } from "../lib/client.js";
import { createFakeDesktop } from "../desktop/index.js";
import { buildTurn, taskStates } from "../lib/client-turn.js";

const mode = process.argv[2] || "codex";
if (!["codex", "local"].includes(mode)) throw new Error("Использование: brain-smoke.ts codex|local");
const server = await startLabServer({ brain: "off", stt: "mock", keepDir: true, env: {
  LLM_PROVIDER: mode, CODEX_MODEL: process.env.CODEX_MODEL || "gpt-6-luna", TTS_PROVIDER: "mock",
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11435",
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || "qwen3.5:9b-q4_K_M",
  OPENAI_API_KEY: "", ELEVENLABS_API_KEY: "", YANDEX_API_KEY: "", DEEPGRAM_API_KEY: "",
} });
console.log(JSON.stringify({ mode, port: server.port, log: server.outLog }));
const desktop = createFakeDesktop();
const client = await connectLabClient({ server, desktop, confirm: [] });
try {
  const text = "Создай текстовый файл C:\\JarvisLab\\free-brain.txt с единственной строкой МЕСТНЫЙ-ТЕСТ-42. Затем прочитай его инструментом и сообщи содержимое. Это два шага одной задачи.";
  const mark = client.events().length, started = Date.now();
  client.send("dev.text", { text });
  // Первый idle бывает подтверждением приёма, до task.status. Ждём терминала задачи, не earcon.
  let ended: "task_done" | "timeout" = "timeout";
  while (Date.now() - started < 180_000) {
    const events = client.events().slice(mark);
    const tasks = taskStates(events);
    if (tasks.length && tasks.every((t) => ["done", "failed", "cancelled"].includes(t.state))) {
      await new Promise((r) => setTimeout(r, 800)); ended = "task_done"; break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const result = buildTurn(text, client.events().slice(mark), started, ended);
  const effects = desktop.snapshot().effects;
  const metrics = await server.metrics();
  const report = { mode, result, effects, metrics, snapshot: desktop.snapshot() };
  const dir = resolve("docs/lab/runs"); await mkdir(dir, { recursive: true });
  const path = resolve(dir, `no-api-${mode}-${Date.now()}.json`);
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ mode, answer: result.answer, ms: result.ms, ended: result.ended,
    actions: result.actions.map((a) => ({ kind: a.cmd.kind, ok: a.result.ok })), effects, report: path }));
  if (result.ended === "timeout" || !result.actions.some((a) => a.cmd.kind === "fs.write" && a.result.ok)
    || !result.actions.some((a) => a.cmd.kind === "fs.read" && a.result.ok)
    || desktop.snapshot().files["C:/JarvisLab/free-brain.txt"] !== "МЕСТНЫЙ-ТЕСТ-42") process.exitCode = 1;
} finally { await client.close(); await server.stop({ keepDir: true }); }
