/** Разбор вывода инструментов проверки: vitest (JSON-файл), node --test (TAP/spec), tsc, гейт размеров. Чистые функции. */
import type { SkippedTest, TestCounts } from "./types.js";

export interface VitestParsed {
  tests: TestCounts;
  /** Файлы, упавшие целиком (ошибка импорта/сборки): тестов в них нет, но зелёным это быть не может. */
  failedSuites: string[];
  failedTests: string[];
  skipped: Array<Omit<SkippedTest, "reason">>;
  /** Исход каждого теста (для флейк-скана): ключ «файл > имя». Упавший файл целиком — ключ «файл > <файл>». */
  outcomes: Map<string, "passed" | "failed" | "skipped">;
}

interface VitestAssertion { status?: string; fullName?: string; title?: string }
interface VitestFile { name?: string; status?: string; assertionResults?: VitestAssertion[] }

/** Путь к тесту относительно корня репозитория, с прямыми слэшами. */
export const relPath = (root: string, abs: string): string => {
  const a = abs.split("\\").join("/");
  const r = root.split("\\").join("/").replace(/\/$/u, "");
  return a.startsWith(`${r}/`) ? a.slice(r.length + 1) : a;
};

/** Считаем сами по assertionResults: numTotalTests у vitest смешивает todo/skipped. Битый JSON → null (шаг падает). */
export function parseVitestJson(text: string, root: string): VitestParsed | null {
  let j: { testResults?: VitestFile[] };
  try {
    j = JSON.parse(text.slice(text.indexOf("{")));
  } catch {
    return null;
  }
  const out: VitestParsed = { tests: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 }, failedSuites: [], failedTests: [], skipped: [], outcomes: new Map() };
  for (const f of j.testResults ?? []) {
    const file = relPath(root, f.name ?? "?");
    const rs = f.assertionResults ?? [];
    if (f.status === "failed" && !rs.some((a) => a.status === "failed")) { out.failedSuites.push(file); out.outcomes.set(`${file} > <файл>`, "failed"); }
    for (const a of rs) {
      const name = a.fullName ?? a.title ?? "?";
      out.tests.total++;
      out.outcomes.set(`${file} > ${name}`, a.status === "passed" ? "passed" : a.status === "failed" ? "failed" : "skipped");
      if (a.status === "passed") out.tests.passed++;
      else if (a.status === "failed") { out.tests.failed++; out.failedTests.push(`${file} > ${name}`); }
      else if (a.status === "todo") out.tests.todo++;
      else { out.tests.skipped++; out.skipped.push({ file, name }); }
    }
  }
  return out;
}

/** Итог `node --test`: в TAP это `# pass 5`, в spec — `ℹ pass 5`. Нет строк итога → null (не считаем зелёным). */
export function parseNodeTest(out: string): TestCounts | null {
  const n = (k: string): number | null => {
    const m = new RegExp(`^(?:#|ℹ)\\s+${k}\\s+(\\d+)\\s*$`, "mu").exec(out);
    return m ? Number(m[1]) : null;
  };
  const total = n("tests");
  const passed = n("pass");
  if (total === null || passed === null) return null;
  return { total, passed, failed: (n("fail") ?? 0) + (n("cancelled") ?? 0), skipped: n("skipped") ?? 0, todo: n("todo") ?? 0 };
}

/** Ошибки tsc: строки `file(1,2): error TS1234: ...`. */
export function parseTsc(out: string): string[] {
  return out.split(/\r?\n/u).filter((l) => /\berror TS\d+:/u.test(l)).map((l) => l.trim());
}

export interface FnLengthRow { file: string; name: string; lines: number }

/** Вывод fn-lengths.mjs: `  589  src/gateway/server.ts:121-709  createGateway`. Ключ файл+имя (номера строк плывут). */
export function parseFnLengths(out: string): FnLengthRow[] | null {
  if (!/функций:\s*\d+/u.test(out)) return null;
  const rows: FnLengthRow[] = [];
  for (const l of out.split(/\r?\n/u)) {
    const m = /^\s*(\d+)\s+(\S+?):\d+-\d+\s+(\S+)\s*$/u.exec(l);
    if (m) rows.push({ lines: Number(m[1]), file: m[2] ?? "", name: m[3] ?? "" });
  }
  return rows;
}
