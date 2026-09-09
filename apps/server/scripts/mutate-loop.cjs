// W3 «Петля»: мутационная таблица рефакторинга. Применяет ОДНУ мутацию к коду петли, гоняет тесты
// каталога src/brain/agent, печатает упавшие тесты, восстанавливает файлы. Смысл: те же тесты должны
// падать на тех же поломках ДО и ПОСЛЕ рефакторинга (иначе структура съела семантику).
// Запуск из apps/server: node scripts/mutate-loop.cjs [имя|all] [файл-отчёта.json]
// Каждая мутация — список альтернативных якорей [файл, было, стало]: берётся первый найденный (так одна
// таблица работает и на старой петле-монолите, и на LoopState/фазах).
const fs = require("fs");
const { spawnSync } = require("child_process");
const IDX = "src/brain/agent/index.ts";
const alt = (...variants) => variants;
const MUTS = {
  "gate-snapshot": alt(
    [IDX, `const gateStoppedPrevRound = gateStoppedRound;`, `const gateStoppedPrevRound = false;`],
    [IDX, `const gateStoppedPrevRound = st.honesty.gateStoppedRound;`, `const gateStoppedPrevRound = false;`],
    ["src/brain/agent/loop/round-snapshot.ts", `gateStoppedPrevRound: st.honesty.gateStoppedRound,`, `gateStoppedPrevRound: false,`],
  ),
  "declined-gates-mutate": alt(
    [IDX, `if (r.declined !== true && r.uncertain !== true && (!OUTBOUND_SEND_TOOLS.has(tu.name) || r.sent === true)) anyMutateSucceeded = true;`, `if (r.uncertain !== true && (!OUTBOUND_SEND_TOOLS.has(tu.name) || r.sent === true)) anyMutateSucceeded = true;`],
    [IDX, `if (r.declined !== true && r.uncertain !== true && (!OUTBOUND_SEND_TOOLS.has(tu.name) || r.sent === true)) st.honesty.anyMutateSucceeded = true;`, `if (r.uncertain !== true && (!OUTBOUND_SEND_TOOLS.has(tu.name) || r.sent === true)) st.honesty.anyMutateSucceeded = true;`],
    ["src/brain/agent/loop/tool-round.ts", `if (r.declined !== true && r.uncertain !== true && (!OUTBOUND_SEND_TOOLS.has(tu.name) || r.sent === true)) st.honesty.anyMutateSucceeded = true;`, `if (r.uncertain !== true && (!OUTBOUND_SEND_TOOLS.has(tu.name) || r.sent === true)) st.honesty.anyMutateSucceeded = true;`],
  ),
  "input-denied-flag": alt(
    [IDX, `      inputDenied = true;\n      return false;`, `      return false;`],
    [IDX, `      st.honesty.inputDenied = true;\n      return false;`, `      return false;`],
    ["src/brain/agent/loop/input-lease.ts", `    st.honesty.inputDenied = true;\n    return false;`, `    return false;`],
  ),
  "veil-mutate-only": alt(
    [IDX, `if (tu.name !== "screen_selection" && (effOfCall === "mutate" || (procedureStopped && reportOfThisTurn))) {`, `if (true) {`],
    ["src/brain/agent/loop/tool-round.ts", `if (tu.name !== "screen_selection" && (effOfCall === "mutate" || (procedureStopped && reportOfThisTurn))) {`, `if (true) {`],
  ),
  "partial-by-source": alt(
    [IDX, `    partialBySource.set(source, k);\n    overlayPartialTotal = [...partialBySource.values()].reduce((a, b) => a + b, 0);`, `    overlayPartialTotal += k;`],
    [IDX, `    st.honesty.partialBySource.set(source, k);\n    st.honesty.overlayPartialTotal = [...st.honesty.partialBySource.values()].reduce((a, b) => a + b, 0);`, `    st.honesty.overlayPartialTotal += k;`],
    ["src/brain/agent/loop/helpers.ts", `  st.honesty.partialBySource.set(source, k);\n  st.honesty.overlayPartialTotal = [...st.honesty.partialBySource.values()].reduce((a, b) => a + b, 0);`, `  st.honesty.overlayPartialTotal += k;`],
  ),
  "verified-after-veil-rearm": alt(
    [IDX, `          verifiedAfterVeil = false;\n          // Контроль-8 (verified-after-veil-rearm)`, `          // Контроль-8 (verified-after-veil-rearm)`],
    [IDX, `          st.honesty.verifiedAfterVeil = false;\n          // Контроль-8 (verified-after-veil-rearm)`, `          // Контроль-8 (verified-after-veil-rearm)`],
    ["src/brain/agent/loop/tool-round.ts", `        st.honesty.verifiedAfterVeil = false;\n        // Контроль-8 (verified-after-veil-rearm)`, `        // Контроль-8 (verified-after-veil-rearm)`],
  ),
  "cap-by-loop-iters": alt(
    [IDX, `    loopIters >= HARD_STEP_CAP && !finalText && !cancelled`, `    round >= HARD_STEP_CAP && !finalText && !cancelled`],
    [IDX, `    st.progress.loopIters >= HARD_STEP_CAP && !st.progress.finalText && !st.exit.cancelled`, `    st.progress.round >= HARD_STEP_CAP && !st.progress.finalText && !st.exit.cancelled`],
    ["src/brain/agent/loop/outcome.ts", `st.progress.loopIters >= cfg.HARD_STEP_CAP && !st.progress.finalText && !st.exit.cancelled`, `st.progress.round >= cfg.HARD_STEP_CAP && !st.progress.finalText && !st.exit.cancelled`],
  ),
  "sent-required-for-outbound": alt(
    [IDX, `(!OUTBOUND_SEND_TOOLS.has(tu.name) || r.sent === true)) anyMutateSucceeded = true;`, `true) anyMutateSucceeded = true;`],
    [IDX, `(!OUTBOUND_SEND_TOOLS.has(tu.name) || r.sent === true)) st.honesty.anyMutateSucceeded = true;`, `true) st.honesty.anyMutateSucceeded = true;`],
    ["src/brain/agent/loop/tool-round.ts", `(!OUTBOUND_SEND_TOOLS.has(tu.name) || r.sent === true)) st.honesty.anyMutateSucceeded = true;`, `true) st.honesty.anyMutateSucceeded = true;`],
  ),
};
const names = process.argv[2] === "all" || !process.argv[2] ? Object.keys(MUTS) : [process.argv[2]];
const table = [];
for (const name of names) {
  const variant = MUTS[name].find(([f, a]) => fs.existsSync(f) && fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n").includes(a));
  if (!variant) { table.push({ name, error: "anchor not found in any variant" }); continue; }
  const [file, a, b] = variant;
  const raw = fs.readFileSync(file, "utf8");
  const crlf = raw.includes("\r\n");
  const orig = raw.replace(/\r\n/g, "\n");
  if (orig.indexOf(a) !== orig.lastIndexOf(a)) { table.push({ name, error: "anchor not unique" }); continue; }
  const mutated = orig.replace(a, b);
  fs.writeFileSync(file, crlf ? mutated.replace(/\n/g, "\r\n") : mutated);
  try {
    const r = spawnSync("npx", ["vitest", "run", "src/brain/agent", "--reporter=json"], { encoding: "utf8", maxBuffer: 1 << 28, shell: true });
    let failed = [];
    try {
      const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
      for (const f of j.testResults ?? []) for (const t of f.assertionResults ?? []) if (t.status === "failed") failed.push(`${f.name.split(/[\\/]/).pop()} > ${t.fullName}`);
    } catch { failed = ["<json parse failed> " + r.stdout.slice(-300)]; }
    table.push({ name, file, failed });
  } finally {
    fs.writeFileSync(file, raw);
  }
}
fs.writeFileSync(process.argv[3] ?? "mutation-table.json", JSON.stringify(table, null, 2));
for (const row of table) console.log(row.name, row.error ?? `${row.failed.length} упало (${row.file})`, (row.failed ?? []).slice(0, 4).map((s) => "\n    " + s.slice(0, 160)).join(""));
