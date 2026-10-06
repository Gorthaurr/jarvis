/** Реальный gateway/модель → WS → Electron → файл на диске; отдельный профиль клиента и БД. */
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { startLabServer } from "../lib/server.js";

const mode = process.argv[2] || "codex";
if (!["codex", "local"].includes(mode)) throw new Error("Expected codex or local");
const dir = await mkdtemp(join(tmpdir(), "jarvis-real-client-"));
const target = join(dir, "actual-client-proof.txt");
const marker = "РЕАЛЬНЫЙ-КЛИЕНТ-42";
const server = await startLabServer({ brain: "off", stt: "mock", keepDir: true, env: {
  LLM_PROVIDER: mode, CODEX_MODEL: "gpt-6-luna", OLLAMA_BASE_URL: "http://127.0.0.1:11435",
  STT_PROVIDER: "whisper", WHISPER_MODEL: "Xenova/whisper-base", HF_ENDPOINT: "https://huggingface.co",
  WHISPER_DEVICE: "cpu", WHISPER_DTYPE: "q8", TTS_PROVIDER: "mock",
  OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", YANDEX_API_KEY: "", ELEVENLABS_API_KEY: "", DEEPGRAM_API_KEY: "",
} });
const log = openSync(join(dir, "electron.log"), "w");
const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(server.port), JARVIS_AUTOSTART: "0" };
delete env.ELECTRON_RUN_AS_NODE;
const client = spawn(resolve("apps/client/node_modules/electron/dist/electron.exe"),
  [resolve("apps/client"), `--user-data-dir=${join(dir, "profile")}`], { env, windowsHide: true, stdio: ["ignore", log, log] });
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = async (path: string, body: unknown) => {
  const r = await fetch(server.httpUrl + path, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-dev-token": server.devToken }, body: JSON.stringify(body) });
  const data = await r.json() as { ok: boolean; data?: unknown; error?: string };
  if (!data.ok) throw new Error(`${path}: ${data.error}`);
  return data;
};
try {
  for (let n = 0; n < 60 && !(await server.health()).sessions; n++) {
    if (client.exitCode !== null) throw new Error(`Electron exited ${client.exitCode}; ${dir}`);
    await delay(500);
  }
  if (!(await server.health()).sessions) throw new Error(`Electron did not connect; ${dir}`);
  await post("/dev/say", { text: `Создай файл ${target} с единственным содержимым ${marker}. Прочитай этот файл инструментом и подтверди точное содержимое. Не трогай другие файлы.` });
  let content = "";
  for (let n = 0; n < 180; n++) {
    content = await readFile(target, "utf8").catch(() => "");
    if (content === marker && JSON.stringify(await server.metrics()).includes("fs_read")) break;
    await delay(1000);
  }
  if (content !== marker) throw new Error(`Real file contents differ; ${dir}; ${server.outLog}`);
  const readback = await post("/dev/action", { kind: "fs.read", path: target });
  if ((readback.data as { content?: string })?.content !== marker) throw new Error("Real Electron readback mismatch");
  const metrics = await server.metrics();
  if (!JSON.stringify(metrics).includes("fs_read")) throw new Error("Model did not verify its file with fs_read");
  await writeFile(resolve("docs/lab/runs", `no-api-real-client-${mode}.json`), JSON.stringify({ mode, target, content, readback, metrics, serverLog: server.outLog, clientLog: join(dir, "electron.log") }, null, 2));
  console.log(JSON.stringify({ mode, realClient: true, exactFile: true, clientReadback: true, clientLog: join(dir, "electron.log") }));
} finally {
  if (client.exitCode === null && client.pid) { try { execFileSync("taskkill", ["/PID", String(client.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {} }
  closeSync(log); await server.stop({ keepDir: true });
}
