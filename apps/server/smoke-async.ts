/**
 * Headless-смоук async-контура (§20): поднимает РЕАЛЬНЫЙ gateway в стаб-режиме (без
 * ключей/БД — детерминированно) и гоняет dev.text-путь живым WS-клиентом, который
 * подтверждает action.command (имитация актуаторов клиента). Проверяет:
 *   1) boot + handshake (новые пути: acks.warm, makeSessionContext с арендой ввода);
 *   2) tier0 «открой ютуб» → browser.open round-trip → «Открыл, сэр»;
 *   3) многошаговая задача → МГНОВЕННЫЙ дворецкий ack (async-путь жив, разговор свободен).
 * Не зависит от сети/LLM/Postgres. Запуск: tsx smoke-async.ts.
 */
// Жёстко в стаб-режим ДО загрузки модулей приложения (динамический импорт ниже).
for (const k of [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPGRAM_API_KEY",
  "ELEVENLABS_API_KEY",
  "DATABASE_URL",
  "BRAVE_SEARCH_API_KEY",
  "ANTHROPIC_BASE_URL",
]) {
  delete process.env[k];
}
process.env.PORT = "8791";
process.env.HOST = "127.0.0.1";
process.env.STT_PROVIDER = "mock";
process.env.LOG_LEVEL = "warn";

const { createLogger } = await import("@jarvis/shared");
const { makeEnvelope, PROTOCOL_VERSION } = await import("@jarvis/protocol");
const { loadConfig } = await import("./src/config.js");
const { createGateway } = await import("./src/gateway/server.js");

const log = createLogger("smoke");
const PORT = 8791;

type Env = { id: string; type: string; payload: Record<string, unknown> };
const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name} — ${detail}`);
};

const gw = createGateway(loadConfig(), log);
await gw.listen();
console.log(`gateway up on :${PORT}`);

const transcripts: string[] = [];
const actionKinds: string[] = [];
let stage: "hello" | "tier0" | "task" | "done" = "hello";

await new Promise<void>((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const send = (type: string, payload: Record<string, unknown>) =>
    ws.send(JSON.stringify(makeEnvelope(type, payload)));

  const finish = (): void => {
    stage = "done";
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    resolve();
  };
  const hardStop = setTimeout(() => {
    if (stage !== "done") record(`stage:${stage}`, false, "таймаут — ожидаемое сообщение не пришло");
    finish();
  }, 10_000);
  hardStop.unref?.();

  ws.addEventListener("open", () => {
    send("client.hello", { protocolVersion: PROTOCOL_VERSION });
  });

  ws.addEventListener("message", (ev: MessageEvent) => {
    let env: Env;
    try {
      env = JSON.parse(String(ev.data)) as Env;
    } catch {
      return;
    }

    if (env.type === "server.hello") {
      record("handshake", true, `server.hello (resumed=${String(env.payload.resumed)})`);
      stage = "tier0";
      send("dev.text", { text: "открой ютуб" });
      return;
    }

    if (env.type === "action.command") {
      const kind = String(env.payload.kind ?? "");
      actionKinds.push(kind);
      // Имитируем актуатор клиента: успешный результат с тем же commandId (= env.id).
      send("action.result", { commandId: env.id, ok: true, durationMs: 1 });
      return;
    }

    if (env.type === "transcript" && env.payload.final === true) {
      const text = String(env.payload.text ?? "");
      transcripts.push(text);

      if (stage === "tier0") {
        const ok = /открыл/i.test(text) && actionKinds.includes("browser.open");
        record("tier0: «открой ютуб» → round-trip", ok, `cmd=[${actionKinds.join(",")}] transcript="${text}"`);
        stage = "task";
        send("dev.text", { text: "создай на рабочем столе файл и напиши туда привет" });
        return;
      }

      if (stage === "task") {
        // Многошаговая (созда…) → sonnet + speakResult → МГНОВЕННЫЙ дворецкий ack.
        const ok = /сэр/i.test(text);
        record("async: задача → мгновенный дворецкий ack", ok, `transcript="${text}"`);
        finish();
        return;
      }
    }
  });

  ws.addEventListener("error", (e: Event) => {
    record(`ws-error@${stage}`, false, String((e as ErrorEvent).message ?? e.type));
    finish();
  });
});

await gw.close();

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n=== SMOKE: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 && results.length >= 3 ? 0 : 1);
