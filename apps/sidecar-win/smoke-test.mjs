// Дымовой тест сайдкара: общается по тому же stdio JSON-line протоколу, что и клиент.
// Проверяет: процесс жив, UIA-грундинг находит окно, read.window даёт текст, ошибка корректна.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const exe = join(__dirname, "bin", "Release", "net8.0-windows10.0.19041.0", "win-x64", "SidecarWin.exe");

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

  // 5) §Волна2 (2.4): window.list — окна верхнего уровня с pid/process/title.
  const wl = await rpc("5", "window.list", {});
  check("window.list → окна", wl.ok === true && Array.isArray(wl.data?.windows) && wl.data.windows.length > 0,
    wl.ok ? `${wl.data.windows.length} окон, fg="${wl.data.windows.find((w) => w.foreground)?.title ?? "?"}"` : wl.error);

  // 6) §Волна2 (2.4): ui.snapshot — интерактивные элементы активного окна (set-of-marks).
  const snap = await rpc("6", "ui.snapshot", { maxItems: 30 }, 15000);
  check("ui.snapshot → items", snap.ok === true && Array.isArray(snap.data?.items),
    snap.ok ? `"${snap.data.window}" → ${snap.data.items.length} элементов${snap.data.truncated ? " (усечено)" : ""}` : snap.error);

  // 7) §Волна2 (2.4): mouse с кривым op → корректная ошибка (мышь юзера НЕ трогаем в смоуке).
  const badMouse = await rpc("7", "mouse", { op: "nonsense" });
  check("mouse с кривым op → ошибка", badMouse.ok === false);

  // 8) §Волна2 (2.3): ocr — распознание 1x1 PNG (валидный путь декодера; текста нет = честно пусто).
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const ocr = await rpc("8", "ocr", { imageB64: tinyPng }, 15000);
  check("ocr → text (движок жив)", ocr.ok === true && typeof ocr.data?.text === "string",
    ocr.ok ? `"${ocr.data.text}" (${ocr.data.lines.length} строк)` : ocr.error);

  // 9) §Волна2 (2.4): ground с nameMode:"substring" находит окно по заведомо ЧАСТИЧНОМУ имени
  // (ревью: Program.cs терял nameMode/automationId → substring молча работал как exact → «не найдено»).
  // Кандидаты — из window.list (п.5); частичное имя не должно совпадать с чьим-то ПОЛНЫМ заголовком,
  // иначе негативный exact-контроль ниже ловил бы честное совпадение вместо регрессии.
  const winTitles = (wl.ok ? wl.data.windows : []).map((w) => (w.title ?? "").trim());
  const allTitlesLc = winTitles.map((t) => t.toLowerCase());
  const partials = winTitles
    .filter((t) => t.length >= 5)
    .map((t) => t.slice(1, -1).toLowerCase()) // строгая подстрока; lower — заодно проверяем IgnoreCase
    .filter((p) => p.length >= 3 && !allTitlesLc.includes(p))
    .slice(0, 3);
  let subHit = null;
  let subErr = "нет подходящего окна (заголовок ≥5 симв.) в window.list";
  for (const [i, partial] of partials.entries()) {
    const g9 = await rpc(`9-${i}`, "ground", { role: "window", name: partial, nameMode: "substring", scope: "desktop" }, 15000);
    if (g9.ok === true && (g9.data?.name ?? "").toLowerCase().includes(partial)) { subHit = { partial, found: g9.data.name }; break; }
    subErr = g9.ok ? `нашлось "${g9.data?.name}" без вхождения "${partial}"` : g9.error;
  }
  check("ground nameMode:substring по частичному имени", subHit !== null,
    subHit ? `"${subHit.partial}" → "${subHit.found}"` : subErr);
  // 9b) Негативный контроль: то же частичное имя БЕЗ nameMode (exact) → честное «не найдено».
  // Если бы nameMode снова терялся, п.9 и п.9b стали бы неразличимы — вместе они ловят регрессию.
  if (subHit) {
    const g9b = await rpc("9b", "ground", { role: "window", name: subHit.partial, scope: "desktop" }, 15000);
    check("ground exact по тому же частичному имени → не найдено", g9b.ok === false,
      g9b.ok === false ? "" : `неожиданно нашлось "${g9b.data?.name}"`);
  }
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
