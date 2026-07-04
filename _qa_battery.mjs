// QA-батарея: гоняю Джарвиса текстом по всем кейсам, меряю латентность, ловлю реплики.
// Безопасность: confirm на необратимое (выключение/удаление) ОТКЛОНЯЮ; action.command к клиенту фейкаю.
import { readFileSync } from "node:fs";
const WS_URL = "ws://127.0.0.1:8787/ws";
// [метка, текст, ...follow-ups]. Читаем из файла (argv[2]) — кириллица в JSON.
const BATTERY = JSON.parse(readFileSync(process.argv[2] || "_qa_cmds.json", "utf8"));
const QUIET_MS = 8500, HARD_MS = 75000;
const now = () => Date.now();
const ws = new WebSocket(WS_URL);
const send = (t, p) => ws.send(JSON.stringify({ id: globalThis.crypto.randomUUID(), ts: now(), type: t, payload: p }));
const log = (...a) => console.log(...a);
let i = -1, tSent = 0, settleTimer = null, hardTimer = null, doneSeen = false, results = [], pendingFollow = [];

function finishCurrent(reason) {
  if (i < 0) return;
  clearTimeout(settleTimer); clearTimeout(hardTimer);
  const r = results[i];
  if (r && !r.closed) { r.closed = true; r.total = now() - tSent; r.reason = reason; }
  nextCmd();
}
function armSettle() { clearTimeout(settleTimer); settleTimer = setTimeout(() => finishCurrent(doneSeen ? "done" : "quiet"), QUIET_MS); }
function nextCmd() {
  i += 1;
  if (i >= BATTERY.length) { log("\n@@@ DONE @@@"); log("@@@RESULTS@@@" + JSON.stringify(results)); ws.close(); process.exit(0); }
  const [label, text, ...follows] = BATTERY[i];
  results[i] = { label, cmd: text, replies: [], ack: null, total: null, closed: false }; doneSeen = false; tSent = now();
  pendingFollow = follows.slice();
  log(`\n#${i} [${label}] → «${text}»`);
  send("dev.text", { text });
  // отложенные follow-ups (для continuity на лету) — шлём через 3.5с/5с
  pendingFollow.forEach((f, k) => setTimeout(() => { if (!results[i].closed) { log(`   ↳ follow → «${f}»`); send("dev.text", { text: f }); } }, 3500 * (k + 1)));
  clearTimeout(hardTimer); hardTimer = setTimeout(() => finishCurrent("HARD"), HARD_MS);
  armSettle();
}
ws.onopen = () => send("client.hello", { token: "dev", clientVersion: "qa", protocolVersion: 1 });
ws.onmessage = (ev) => {
  let e; try { e = JSON.parse(ev.data); } catch { return; }
  const p = e.payload || {};
  switch (e.type) {
    case "server.hello": log("session", p.sessionId); setTimeout(nextCmd, 300); break;
    case "ping": send("pong", {}); break;
    case "chat":
      if (p.role === "assistant") { const r = results[i]; if (r) { if (!r.ack) r.ack = now() - tSent; r.replies.push(p.text); } log(`   ⟵ ${String(p.text).replace(/\s+/g, " ").slice(0, 220)}`); armSettle(); }
      break;
    case "task.status": if (["done", "failed", "cancelled"].includes(p.state)) { doneSeen = true; log(`   [task ${p.state}]`); armSettle(); } break;
    case "ui.display": { const r = results[i]; if (r) r.card = String(p.markdown || "").slice(0, 200); log(`   [card] ${p.title || ""}: ${String(p.markdown || "").replace(/\s+/g, " ").slice(0, 120)}`); armSettle(); } break;
    case "user.confirm.request": {
      // БЕЗОПАСНОСТЬ: подтверждаем только явно безопасное (отправка в Избранное/Saved); остальное — DENY.
      const s = String(p.summary || "").toLowerCase();
      const safe = /избранн|saved|saved messages/.test(s);
      log(`   [confirm:${p.kind}] ${p.summary} → ${safe ? "approve" : "DENY (safety)"}`);
      send("user.confirm.result", { requestId: p.requestId, approved: safe });
      const r = results[i]; if (r) r.confirmAsked = p.summary;
      break;
    }
    case "action.command": { const r = results[i]; if (r) (r.actions = r.actions || []).push(p.kind); log(`   [action→client] ${p.kind}`); send("action.result", { commandId: e.id, ok: true, durationMs: 1 }); break; }
  }
};
setTimeout(() => { log("@@@RESULTS@@@" + JSON.stringify(results)); process.exit(0); }, 600000);
