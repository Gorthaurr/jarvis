// Драйвер Джарвиса текстом (dev.text) — гоняю команды как пользователь, смотрю результат сам.
// Запуск: node _jarvis_cmd.mjs "команда1" "да, отправляй" ...  (шлёт по очереди с паузой, отвечает на ping)
const WS_URL = "ws://127.0.0.1:8787/ws";
const msgs = process.argv.slice(2).filter((a) => !/^\d+$/.test(a));
const STEP_MS = 11000; // пауза между репликами (даём агенту ответить/спросить «отправляю?»)
const TIMEOUT_MS = 130000;
const ws = new WebSocket(WS_URL);
const send = (type, payload) =>
  ws.send(JSON.stringify({ id: globalThis.crypto.randomUUID(), ts: Date.now(), type, payload }));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let idx = 0;
const sendNext = () => {
  if (idx >= msgs.length) return;
  const t = msgs[idx++];
  log("→ dev.text:", t);
  send("dev.text", { text: t });
  if (idx < msgs.length) setTimeout(sendNext, STEP_MS);
};

ws.onopen = () => {
  log("WS open → hello");
  send("client.hello", { token: "dev", clientVersion: "cmd-test", protocolVersion: 1 });
};
ws.onerror = (e) => log("WS error", e.message || e);
ws.onclose = () => log("WS closed");
ws.onmessage = (ev) => {
  let env;
  try { env = JSON.parse(ev.data); } catch { return; }
  const p = env.payload || {};
  switch (env.type) {
    case "server.hello":
      log("server.hello session=", p.sessionId, "resumed=", p.resumed);
      setTimeout(sendNext, 300);
      break;
    case "ping":
      send("pong", {}); // КЛЮЧЕВОЕ: иначе heartbeat закроет сессию
      break;
    case "chat":
      log(`CHAT[${p.role}]:`, p.text);
      break;
    case "transcript":
      if (p.final) log("transcript:", p.text);
      break;
    case "task.status":
      log(`task[${p.state}]`, p.title || "", `${p.stepsDone ?? ""}/${p.stepsTotal ?? ""}`);
      break;
    case "ui.display":
      log("CARD:", p.title || "", String(p.markdown || "").slice(0, 200));
      break;
    case "user.confirm.request":
      log("CONFIRM-REQ:", p.kind, "—", p.summary, "→ AUTO-APPROVE");
      send("user.confirm.result", { requestId: p.requestId, approved: true });
      break;
    case "action.command":
      log("ACTION→client:", p.kind, JSON.stringify(p).slice(0, 160));
      // не настоящий клиент: отвечаем ok, чтобы петля агента не висла (telegram идёт мимо этого — через расширение)
      send("action.result", { commandId: env.id, ok: true, durationMs: 1 });
      break;
    case "speak.chunk":
    case "ping":
    case "transcript":
      break;
    default:
      log("msg:", env.type);
  }
};
setTimeout(() => { log("--- timeout, закрываю ---"); try { ws.close(); } catch {} process.exit(0); }, TIMEOUT_MS);
