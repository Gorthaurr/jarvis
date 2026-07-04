// Медленный ПОСЛЕДОВАТЕЛЬНЫЙ драйвер: одна команда за раз, ждём ПОЛНОГО завершения (тишина 14с
// после последней реплики ИЛИ task done/failed + 3с), потом следующая. Изолирует реальные баги от
// гонки фоновых задач. Команды из argv (или дефолт). Печатает реплики/экшены/таски/конфирмы.
import { readFileSync } from "node:fs";
const WS = "ws://127.0.0.1:8787/ws";
const arg = process.argv[2] || '["какие навыки у тебя есть?"]';
const RAW = JSON.parse(arg.endsWith(".json") ? readFileSync(arg, "utf8") : arg);
// Поддержка обоих форматов: плоские строки ИЛИ пары [label, text] (берём текст — последний элемент).
const CMDS = RAW.map((c) => (Array.isArray(c) ? String(c[c.length - 1]) : String(c)));
const QUIET = 14000, HARD = 70000;
const ws = new WebSocket(WS);
const send = (t, p) => ws.send(JSON.stringify({ id: crypto.randomUUID(), ts: Date.now(), type: t, payload: p }));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let i = -1, quietT = null, hardT = null, t0 = 0;
function next() {
  clearTimeout(quietT); clearTimeout(hardT);
  i++;
  if (i >= CMDS.length) { log("=== ALL DONE ==="); ws.close(); process.exit(0); }
  t0 = Date.now();
  log(`\n#${i} → «${CMDS[i]}»`);
  send("dev.text", { text: CMDS[i] });
  arm();
  hardT = setTimeout(() => { log(`   [HARD ${HARD}ms]`); next(); }, HARD);
}
function arm() { clearTimeout(quietT); quietT = setTimeout(() => { log(`   [settled ${((Date.now()-t0)/1000).toFixed(1)}s]`); next(); }, QUIET); }
ws.onopen = () => send("client.hello", { token: "dev", clientVersion: "qa-slow", protocolVersion: 1 });
ws.onmessage = (ev) => {
  let e; try { e = JSON.parse(ev.data); } catch { return; }
  const p = e.payload || {};
  switch (e.type) {
    case "server.hello": log("session", p.sessionId); setTimeout(next, 300); break;
    case "ping": send("pong", {}); break;
    case "chat": if (p.role === "assistant") { log(`   ⟵ ${String(p.text).replace(/\s+/g, " ").slice(0, 240)}`); arm(); } break;
    case "task.status": if (["done","failed","cancelled"].includes(p.state)) { log(`   [task ${p.state}]`); clearTimeout(quietT); quietT = setTimeout(next, 3000); } break;
    case "ui.display": log(`   [card] ${p.title||""}: ${String(p.markdown||"").replace(/\s+/g," ").slice(0,120)}`); arm(); break;
    case "user.confirm.request": { const s = String(p.summary||"").toLowerCase(); const safe = /избранн|saved/.test(s); log(`   [confirm:${p.kind}] ${p.summary} → ${safe?"approve":"DENY"}`); send("user.confirm.result", { requestId: p.requestId, approved: safe }); break; }
    case "action.command": log(`   [action→client] ${p.kind}`); send("action.result", { commandId: e.id, ok: true, durationMs: 1 }); break;
  }
};
setTimeout(() => { log("global timeout"); process.exit(0); }, 300000);
