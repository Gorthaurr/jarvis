// W3 «Петля»: мутационная таблица рефакторинга. Применяет ОДНУ мутацию к коду петли, гоняет тесты
// каталога src/brain/agent, печатает упавшие тесты, восстанавливает файл. Смысл: те же тесты должны
// падать на тех же поломках ДО и ПОСЛЕ рефакторинга (иначе структура съела семантику).
// Запуск из apps/server: node scripts/mutate-loop.cjs [имя|all] [файл-отчёта.json] (деф — во временной папке ОС, не в репозитории)
// Якоря пишутся БЕЗ отступа (каждая строка trim), ищутся по всем файлам петли (index.ts + loop/*.ts)
// с любым отступом — так одна таблица работает и на петле-монолите, и на фазах.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
// W2 (П4): + серия act{steps} (маршрут dispatchTool, раскрытие по шагу) и её тест — к каталогу тестов петли.
const FILES = ["src/brain/agent/index.ts", ...fs.readdirSync("src/brain/agent/loop").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => "src/brain/agent/loop/" + f), "src/brain/tools/handlers/act-steps.ts", "src/brain/tools/handlers/act-steps-result.ts"];
const TESTS = ["src/brain/agent", "src/brain/tools/handlers/act-steps.test.ts"];
const MUTS = {
  "gate-snapshot": [`const gateStoppedPrevRound = st.honesty.gateStoppedRound;`, `const gateStoppedPrevRound = false;`],
  "declined-gates-mutate": [`if (r.declined !== true && r.uncertain !== true && (!OUTBOUND_SEND_TOOLS.has(tu.name) || r.sent === true)) st.honesty.anyMutateSucceeded = true;`, `if (r.uncertain !== true && (!OUTBOUND_SEND_TOOLS.has(tu.name) || r.sent === true)) st.honesty.anyMutateSucceeded = true;`],
  "input-denied-flag": [`st.honesty.inputDenied = true;\nreturn false;`, `return false;`],
  "veil-mutate-only": [`if (tu.name !== "screen_selection" && (effOfCall === "mutate" || (procedureStopped && reportOfThisTurn))) {`, `if (true) {`],
  "partial-by-source": [`st.honesty.partialBySource.set(source, k);\nst.honesty.overlayPartialTotal = [...st.honesty.partialBySource.values()].reduce((a, b) => a + b, 0);`, `st.honesty.overlayPartialTotal += k;`],
  "verified-after-veil-rearm": [`st.honesty.verifiedAfterVeil = false;\n// Контроль-8 (verified-after-veil-rearm)`, `// Контроль-8 (verified-after-veil-rearm)`],
  "cap-by-loop-iters": [`st.progress.loopIters >= HARD_STEP_CAP && !st.progress.finalText && !st.exit.cancelled`, `st.progress.round >= HARD_STEP_CAP && !st.progress.finalText && !st.exit.cancelled`],
  "sent-required-for-outbound": [`(!OUTBOUND_SEND_TOOLS.has(tu.name) || r.sent === true)) st.honesty.anyMutateSucceeded = true;`, `true) st.honesty.anyMutateSucceeded = true;`],
  // W2 (П4, G-8): стоп раунда после провала мутации и его края (round-stop-loop.test.ts, loop/round-stop.test.ts).
  "round-stop": [`if (skipAfterStop(ctx, tu, round)) continue;`, `if (false) continue;`],
  "round-stop-reads": [`if (round.stoppedBy === undefined || ctx.effectOf(tu.name, tu.input) !== "mutate") return false;`, `if (round.stoppedBy === undefined) return false;`],
  "round-stop-count-stub": [`round.skippedIds.add(tu.id);`, `round.skippedIds.add(tu.id); round.roundErrors += 1;`],
  "round-stop-anyerrored": [`const anyErrored = real.some((b) => b.type === "tool_result" && b.is_error === true);`, `const anyErrored = round.resultBlocks.some((b) => b.type === "tool_result" && b.is_error === true);`],
  // W2 (П4): серия act{steps} — стоп на первом провале, отмена между шагами, кап картинок, отказ §14 наружу, тихие промежуточные.
  "steps-stop-first-error": [`stop = stopReasonOf(r);`, `stop = null;`],
  "steps-cancel": [`if (ctx.isCancelled?.()) stop = "cancelled";`, `if (false) stop = "cancelled";`],
  "steps-image-cap": [`const keep = new Set(imageSteps.slice(-MAX_SERIES_IMAGES));`, `const keep = new Set(imageSteps);`],
  "steps-declined-out": [`if (stop === "declined") out.declined = true;`, `if (false) out.declined = true;`],
  "steps-observe-quiet": [`const quiet = !last && s.verify === undefined && s.observe === undefined;`, `const quiet = false;`],
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
// W2 (П4): прерывание (timeout/Ctrl+C) посреди мутации не оставляет мутированный файл: сигнал обрабатывается, когда
// вернётся spawnSync (прогон тестов), — файл восстанавливается из копии в памяти, и только потом выход.
let pending = null;
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    if (pending) fs.writeFileSync(pending.file, pending.raw);
    console.error(`прервано (${sig}) — ${pending ? `${pending.file} восстановлен` : "мутаций в работе не было"}`);
    process.exit(130);
  });
}
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
  pending = { file, raw };
  // замена: первая строка якоря → строка(и) мутации с тем же отступом; остальные строки якоря удаляются
  const indent = /^\s*/.exec(lines[at])[0];
  const mutated = [...lines];
  const first = mutated[at];
  const replacedFirst = first.replace(parts[0], b.split("\n")[0].trim());
  mutated.splice(at, parts.length, replacedFirst, ...b.split("\n").slice(1).map((s) => indent + s.trim()));
  fs.writeFileSync(file, mutated.join("\n"));
  try {
    const r = spawnSync("npx", ["vitest", "run", ...TESTS, "--reporter=json"], { encoding: "utf8", maxBuffer: 1 << 28, shell: true });
    let failed = [];
    try {
      const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
      for (const f of j.testResults ?? []) for (const t of f.assertionResults ?? []) if (t.status === "failed") failed.push(`${f.name.split(/[\\/]/).pop()} > ${t.fullName}`);
    } catch { failed = ["<json parse failed> " + r.stdout.slice(-300)]; }
    table.push({ name, file: path.basename(file), failed });
  } finally {
    fs.writeFileSync(file, raw);
    pending = null;
  }
}
const out = process.argv[3] ?? path.join(require("os").tmpdir(), "mutation-table.json");
fs.writeFileSync(out, JSON.stringify(table, null, 2));
console.log("отчёт:", out);
for (const row of table) console.log(row.name, row.error ?? `${row.failed.length} упало (${row.file})`, (row.failed ?? []).slice(0, 4).map((s) => "\n    " + s.slice(0, 160)).join(""));
