/**
 * W2 (пакет 0, P0-f): ГЕЙТ РАЗМЕРОВ МОДУЛЕЙ — закон CLAUDE.md «модули < 150 строк, раздутые файлы не растут».
 * Без шебанга: модуль импортирует vitest, а на Windows-чекауте (CRLF) vite 5 не узнаёт `#!…\r\n` и вставляет
 * импорты ПЕРЕД ним → SyntaxError всего набора (27.09). Запуск — только `node …/module-size-gate.mjs`.
 *
 * Для каждого изменённого относительно BASE не-тестового `.ts` (по всему репозиторию, `git diff --numstat BASE`):
 *  - НОВЫЙ файл — не длиннее 150 строк;
 *  - файл, который в BASE уже длиннее 150 строк, в рабочем дереве не длиннее, чем был;
 *  - исключение — врезка шва ≤ +5 строк, ЯВНО перечисленная аргументом `--allow <путь>` (и в описании PR).
 *
 *   node apps/server/scripts/module-size-gate.mjs <BASE> [--allow path/a.ts --allow path/b.ts] [--json]
 *
 * Код выхода 1 при нарушении. Файл, который в BASE был ≤ 150 и вырос за 150, — тоже нарушение (новый раздутый).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const LIMIT = 150;
export const ALLOW_GROWTH = 5;

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
const lineCount = (text) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));

/** Не-тестовый TypeScript-модуль (тесты, декларации и test-support не судим). */
export function isGatedModule(path) {
  return /\.ts$/u.test(path) && !/\.(test|spec)\.ts$/u.test(path) && !/\.d\.ts$/u.test(path) && !/(^|\/)test-support\//u.test(path);
}

/**
 * Вердикт по одному файлу. base — строк в BASE (null — файла не было), head — строк сейчас (null — удалён).
 * Возвращает строку нарушения или null.
 */
export function judge(path, base, head, allowed) {
  if (head === null) return null;
  if (base === null) return head > LIMIT ? `${path}: новый модуль ${head} строк > ${LIMIT}` : null;
  if (head <= LIMIT) return null;
  if (base <= LIMIT) return `${path}: вырос за ${LIMIT} (${base} → ${head}) — разбей модуль`;
  if (head <= base) return null;
  const growth = head - base;
  if (allowed.has(path) && growth <= ALLOW_GROWTH) return null;
  return `${path}: раздутый модуль вырос ${base} → ${head} (+${growth})${allowed.has(path) ? ` — больше врезки ≤ +${ALLOW_GROWTH}` : " — вынеси логику в новый модуль или перечисли врезку --allow"}`;
}

function main(argv) {
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const base = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--allow");
  if (!base) {
    console.error("usage: module-size-gate.mjs <BASE> [--allow path]... [--json]");
    return 2;
  }
  const allowed = new Set(argv.flatMap((a, i) => (argv[i - 1] === "--allow" ? [a] : [])));
  const changed = git(["diff", "--name-only", "--diff-filter=AMR", base], root)
    .split("\n")
    .concat(git(["ls-files", "--others", "--exclude-standard"], root).split("\n"))
    .map((s) => s.trim())
    .filter((p) => p && isGatedModule(p));
  const rows = [];
  for (const path of [...new Set(changed)]) {
    let baseLines = null;
    try {
      baseLines = lineCount(git(["show", `${base}:${path}`], root));
    } catch {
      baseLines = null; // файла в BASE не было
    }
    const abs = join(root, path);
    const headLines = existsSync(abs) ? lineCount(readFileSync(abs, "utf8")) : null;
    rows.push({ path, base: baseLines, head: headLines, violation: judge(path, baseLines, headLines, allowed) });
  }
  const bad = rows.filter((r) => r.violation);
  if (argv.includes("--json")) console.log(JSON.stringify({ base, rows }, null, 2));
  else {
    for (const r of rows) console.log(`${r.violation ? "✗" : "✓"} ${r.path}: ${r.base ?? "—"} → ${r.head ?? "удалён"}${allowed.has(r.path) ? " (врезка)" : ""}`);
    console.log(bad.length ? `\nНАРУШЕНИЙ: ${bad.length}\n${bad.map((r) => `  ${r.violation}`).join("\n")}` : `\nгейт размеров: ок (${rows.length} модулей)`);
  }
  return bad.length ? 1 : 0;
}

// pathToFileURL, а не `file://${argv[1]}`: на Windows это «file://C:…» против «file:///C:/…» — main не звался, гейт молча отвечал 0 (27.09).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
