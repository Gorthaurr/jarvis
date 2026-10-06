/**
 * ВАЛИДАТОР якорей mutate-loop.cjs. Сам скрипт выполняет мутации при загрузке (require нельзя), а дрейф якоря он
 * прячет в строку «anchor not found» — и мутация тихо не применяется (охрана считается проверенной, а её не гоняли).
 * Здесь: (1) предпроверка за секунды — берём из ТЕКСТА скрипта таблицу MUTS, список FILES и его же findAnchor и
 * ищем каждый якорь ровно один раз; (2) разбор отчёта после полного прогона: любая строка с error = провал.
 */
import { readFileSync, readdirSync } from "node:fs";
import type { StepOutcome } from "./types.js";

export interface AnchorRow { name: string; problem: string | null }

/** Вырезаем объявления из скрипта; макет изменился (нет маркеров) — честный отказ, а не «всё в порядке». */
function extract(script: string): string {
  const from = script.indexOf("const FILES");
  const to = script.indexOf("const names");
  if (from < 0 || to < from || !script.includes("const MUTS") || !script.includes("function findAnchor")) {
    throw new Error("макет mutate-loop.cjs изменился (нет const FILES / const MUTS / function findAnchor / const names) — обнови verify/anchors.ts");
  }
  return script.slice(from, to);
}

/** cwd — apps/server (пути FILES относительные). */
export function validateAnchors(scriptPath: string, cwd: string): AnchorRow[] {
  const decl = extract(readFileSync(scriptPath, "utf8"));
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    const make = new Function("fs", "path", `${decl}\nreturn { FILES, MUTS, findAnchor };`);
    const { FILES, MUTS, findAnchor } = make({ readdirSync, readFileSync }, {}) as {
      FILES: string[];
      MUTS: Record<string, [string, string]>;
      findAnchor: (lines: string[], anchor: string) => number[];
    };
    return Object.entries(MUTS).map(([name, pair]) => {
      for (const file of FILES) {
        const lines = readFileSync(file, "utf8").replace(/\r\n/gu, "\n").split("\n");
        const hits = findAnchor(lines, pair[0]);
        if (hits.length === 1) return { name, problem: null };
        if (hits.length > 1) return { name, problem: `anchor not unique in ${file}` };
      }
      return { name, problem: "anchor not found" };
    });
  } finally {
    process.chdir(prev);
  }
}

export function anchorsOutcome(rows: AnchorRow[]): StepOutcome {
  const bad = rows.filter((r) => r.problem);
  if (!rows.length) return { status: "fail", reason: "таблица MUTS пуста — нечего проверять" };
  return bad.length
    ? { status: "fail", reason: `якоря мутаций дрейфуют (${bad.length} из ${rows.length}): ${bad.map((r) => `${r.name} — ${r.problem}`).join("; ")}` }
    : { status: "pass", notes: [`якорей найдено ровно по одному разу: ${rows.length}`] };
}

interface ReportRow { name: string; error?: string; failed?: string[] }

/** Отчёт mutate-loop после прогона: error и упавший разбор JSON — провал; выживший мутант — «не проверено». */
export function mutationReportOutcome(text: string): StepOutcome {
  let rows: ReportRow[];
  try { rows = JSON.parse(text) as ReportRow[]; } catch { return { status: "fail", reason: "отчёт mutate-loop не разобран" }; }
  const broken = rows.filter((r) => r.error || (r.failed ?? []).some((f) => f.startsWith("<json parse failed>")));
  const survived = rows.filter((r) => !r.error && (r.failed ?? []).length === 0).map((r) => `мутант «${r.name}» выжил: ни один тест не упал`);
  const notes = rows.map((r) => `${r.name}: ${r.error ?? `${r.failed?.length ?? 0} упало`}`);
  return broken.length
    ? { status: "fail", reason: broken.map((r) => `${r.name}: ${r.error ?? "vitest не отдал JSON"}`).join("; "), notes, unverified: survived }
    : { status: "pass", notes, unverified: survived };
}
