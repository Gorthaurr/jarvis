// W3 «Петля»: длина функций в brain/agent — приёмочный критерий «ни одной функции >150 строк».
// Грубый проход по скобкам (без парсера): ловит function-декларации, методы и стрелочные функции,
// присвоенные const/let. Тело = от `{`, идущей ПОСЛЕ закрытия скобок параметров (в типах параметров
// тоже бывают фигурные скобки), до парной `}` включительно.
// Запуск: node scripts/fn-lengths.mjs [минимум строк, деф 150] [каталог, деф src/brain/agent]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MIN = Number(process.argv[2] ?? 150);
const ROOT = process.argv[3] ?? "src/brain/agent";

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const HEAD = /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]*)?=>\s*\{|^\s+(?:private\s+|public\s+|protected\s+|static\s+|async\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/;

function strip(line) {
  return line
    .replace(/\/\/.*$/, "")
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "")
    .replace(/^\s*\*.*$/, "");
}

function scan(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEAD.exec(lines[i]);
    if (!m) continue;
    const name = m[1] ?? m[2] ?? m[3];
    if (!name || ["if", "for", "while", "switch", "catch", "function"].includes(name)) continue;
    let paren = 0, sawParen = false, depth = 0, started = false, end = -1;
    for (let j = i; j < lines.length && end < 0; j++) {
      const s = strip(lines[j]);
      for (const ch of s) {
        if (!started) {
          if (ch === "(") { paren++; sawParen = true; }
          else if (ch === ")") paren--;
          else if (ch === "{" && ((paren === 0 && sawParen) || m[2])) { depth = 1; started = true; }
          continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (depth === 0) { end = j; break; } }
      }
    }
    if (end > i) found.push({ name, file, from: i + 1, to: end + 1, lines: end - i + 1 });
  }
  return found;
}

const all = walk(ROOT).flatMap(scan).sort((a, b) => b.lines - a.lines);
const over = all.filter((f) => f.lines > MIN);
console.log(`функций: ${all.length}, длиннее ${MIN} строк: ${over.length}`);
for (const f of over) console.log(`${String(f.lines).padStart(5)}  ${f.file.replace(/\\/g, "/")}:${f.from}-${f.to}  ${f.name}`);
