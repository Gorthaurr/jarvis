// Дымовой тест сайдкара: общается по тому же stdio JSON-line протоколу, что и клиент.
// Проверяет: процесс жив, UIA-грундинг находит окно, read.window даёт текст, ошибка корректна.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const exe = join(__dirname, "bin", "Release", "net8.0-windows", "win-x64", "SidecarWin.exe");

const child = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map();

child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.event) console.log("  push:", JSON.stringify(msg));
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => process.stderr.write(`[sidecar] ${d}`));

function rpc(id, op, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${op}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
  });
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`); };

try {
  // 1) UIA-грундинг: найти любое окно на рабочем столе.
  const g = await rpc("1", "ground", { role: "window" });
  check("ground(window) → handle+bbox", g.ok === true && typeof g.data?.handle === "number" && g.data?.w >= 0,
    g.ok ? `handle=${g.data.handle} "${g.data.name}" ${Math.round(g.data.w)}x${Math.round(g.data.h)}` : g.error);

  // 2) read.window: текстовая выжимка a11y видимой области (фокус).
  const rw = await rpc("2", "read.window", {});
  check("read.window → text", rw.ok === true && typeof rw.data?.text === "string",
    rw.ok ? `${rw.data.text.length} симв.` : rw.error);

  // 2b) read.screen: клиентский readContext('screen') шлёт именно этот op (M16) —
  // раньше падал «Неизвестная операция». Должен дать текст (выжимка фокусного окна).
  const rs = await rpc("2b", "read.screen", {});
  check("read.screen → text (не 'Неизвестная операция')", rs.ok === true && typeof rs.data?.text === "string",
    rs.ok ? `${rs.data.text.length} симв.` : rs.error);

  // 3) Неизвестная операция → корректная ошибка.
  const bad = await rpc("3", "nonsense.op", {});
  check("неизвестный op → ok:false", bad.ok === false && typeof bad.error === "string");

  // 4) Клик по несуществующему handle → ошибка (а не падение процесса).
  const badClick = await rpc("4", "click", { handle: 999999 });
  check("click по битому handle → ошибка, процесс жив", badClick.ok === false);
} catch (e) {
  check("RPC", false, e.message);
} finally {
  child.stdin.end();
  setTimeout(() => child.kill(), 300);
}

setTimeout(() => {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} проверок прошло`);
  process.exit(passed === results.length ? 0 : 1);
}, 800);
