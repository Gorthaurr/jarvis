// W3 «Петля»: мутационная таблица рефакторинга. Применяет ОДНУ мутацию к коду петли, гоняет тесты
// каталога src/brain/agent, печатает упавшие тесты, восстанавливает файл. Смысл: те же тесты должны
// падать на тех же поломках ДО и ПОСЛЕ рефакторинга (иначе структура съела семантику).
// Запуск из apps/server: node scripts/mutate-loop.cjs [имя|all] [файл-отчёта.json] (деф — во временной папке ОС, не в репозитории)
// Якоря пишутся БЕЗ отступа (каждая строка trim), ищутся по всем файлам петли (index.ts + loop/*.ts)
// с любым отступом — так одна таблица работает и на петле-монолите, и на фазах.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const FILES = ["src/brain/agent/index.ts", ...fs.readdirSync("src/brain/agent/loop").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => "src/brain/agent/loop/" + f)];
const MUTS = {
  "gate-snapshot": [`const gateStoppedPrevRound = st.honesty.gateStoppedRound;`, `const gateStoppedPrevRound = false;`],
  "declined-gates-mutate": [`if (r.declined !== true && r.uncertain !== true && (!OUTBOUND_SEND_TOOLS.has(tu.name) || r.sent === true)) st.honesty.anyMutateSucceeded = true;`, `if (r.uncertain !== true && (!OUTBOUND_SEND_TOOLS.has(tu.name) || r.sent === true)) st.honesty.anyMutateSucceeded = true;`],
  "input-denied-flag": [`st.honesty.inputDenied = true;\nreturn false;`, `return false;`],
  "veil-mutate-only": [`if (tu.name !== "screen_selection" && (effOfCall === "mutate" || (procedureStopped && reportOfThisTurn))) {`, `if (true) {`],
  "partial-by-source": [`st.honesty.partialBySource.set(source, k);\nst.honesty.overlayPartialTotal = [...st.honesty.partialBySource.values()].reduce((a, b) => a + b, 0);`, `st.honesty.overlayPartialTotal += k;`],
  "verified-after-veil-rearm": [`st.honesty.verifiedAfterVeil = false;\n// Контроль-8 (verified-after-veil-rearm)`, `// Контроль-8 (verified-after-veil-rearm)`],
  "cap-by-loop-iters": [`st.progress.loopIters >= HARD_STEP_CAP && !st.progress.finalText && !st.exit.cancelled`, `st.progress.round >= HARD_STEP_CAP && !st.progress.finalText && !st.exit.cancelled`],
  "sent-required-for-outbound": [`(!OUTBOUND_SEND_TOOLS.has(tu.name) || r.sent === true)) st.honesty.anyMutateSucceeded = true;`, `true) st.honesty.anyMutateSucceeded = true;`],
};
/** Найти якорь (многострочный, по trim каждой строки) в файле; вернуть {from,to} индексы строк или null. */
function findAnchor(lines, anchor) {
  const parts = anchor.split("\n").map((s) => s.trim());
  const hits = [];
  for (let i = 0; i + parts.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < parts.length; k++) if (!lines[i + k].trim().includes(parts[k]) || (parts.length === 1 && false)) { ok = false; break; }
    if (ok) hits.push(i);
  }
  return hits;
}
const names = process.argv[2] === "all" || !process.argv[2] ? Object.keys(MUTS) : [process.argv[2]];
const table = [];
for (const name of names) {
  const [a, b] = MUTS[name];
  const parts = a.split("\n").map((s) => s.trim());
  let found = null;
  for (const file of FILES) {
    const lines = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
    const hits = findAnchor(lines, a);
    if (hits.length === 1) { found = { file, lines, at: hits[0] }; break; }
    if (hits.length > 1) { found = { error: `anchor not unique in ${file}` }; break; }
  }
  if (!found) { table.push({ name, error: "anchor not found" }); continue; }
  if (found.error) { table.push({ name, error: found.error }); continue; }
  const { file, lines, at } = found;
  const raw = fs.readFileSync(file, "utf8");
  // замена: первая строка якоря → строка(и) мутации с тем же отступом; остальные строки якоря удаляются
  const indent = /^\s*/.exec(lines[at])[0];
  const mutated = [...lines];
  const first = mutated[at];
  const replacedFirst = first.replace(parts[0], b.split("\n")[0].trim());
  mutated.splice(at, parts.length, replacedFirst, ...b.split("\n").slice(1).map((s) => indent + s.trim()));
  fs.writeFileSync(file, mutated.join("\n"));
  try {
    const r = spawnSync("npx", ["vitest", "run", "src/brain/agent", "--reporter=json"], { encoding: "utf8", maxBuffer: 1 << 28, shell: true });
    let failed = [];
    try {
      const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
      for (const f of j.testResults ?? []) for (const t of f.assertionResults ?? []) if (t.status === "failed") failed.push(`${f.name.split(/[\\/]/).pop()} > ${t.fullName}`);
    } catch { failed = ["<json parse failed> " + r.stdout.slice(-300)]; }
    table.push({ name, file: path.basename(file), failed });
  } finally {
    fs.writeFileSync(file, raw);
  }
}
const out = process.argv[3] ?? path.join(require("os").tmpdir(), "mutation-table.json");
fs.writeFileSync(out, JSON.stringify(table, null, 2));
console.log("отчёт:", out);
for (const row of table) console.log(row.name, row.error ?? `${row.failed.length} упало (${row.file})`, (row.failed ?? []).slice(0, 4).map((s) => "\n    " + s.slice(0, 160)).join(""));
