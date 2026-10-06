/** Сводка, аудит «зелёный ≠ проверено» и JSON-отчёт docs/lab/runs/<дата-время>.json. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileName, RunReport, StepResult } from "./types.js";

export function buildReport(o: { profile: ProfileName; startedAt: Date; finishedAt: Date; base: string | null; chromePath: boolean; steps: StepResult[] }): RunReport {
  const { steps } = o;
  const unverified = steps.flatMap((s) => [
    ...(s.status === "skip" ? [`${s.id}: ПРОПУЩЕН — ${s.reason ?? "без причины"}`] : []),
    ...(s.unverified ?? []).map((u) => `${s.id}: ${u}`),
  ]);
  return {
    version: 1,
    profile: o.profile,
    startedAt: o.startedAt.toISOString(),
    finishedAt: o.finishedAt.toISOString(),
    ms: o.finishedAt.getTime() - o.startedAt.getTime(),
    base: o.base,
    host: { platform: process.platform, node: process.version, chromePath: o.chromePath },
    ok: steps.length > 0 && steps.every((s) => s.status !== "fail"),
    steps,
    audit: {
      skippedTests: steps.reduce((n, s) => n + (s.skipped?.length ?? 0), 0),
      skippedSteps: steps.filter((s) => s.status === "skip").map((s) => ({ id: s.id, reason: s.reason ?? "" })),
      unverified,
    },
  };
}

const pad = (n: number): string => String(n).padStart(2, "0");
/** Имя файла из локального времени: 20260929-013045 — сортировка по имени = по времени. */
export const reportFileName = (d: Date): string =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;

export function writeReport(r: RunReport, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, reportFileName(new Date(r.startedAt)));
  writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  return file;
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}с`;

export function formatSummary(r: RunReport): string {
  const L: string[] = [`\nverify:${r.profile}  base=${r.base ?? "—"}  ${secs(r.ms)}  ${r.ok ? "ЗЕЛЁНОЕ" : "КРАСНОЕ"}\n`];
  for (const s of r.steps) {
    const t = s.tests ? `  тестов ${s.tests.passed}/${s.tests.total}${s.tests.skipped ? `, пропущено ${s.tests.skipped}` : ""}${s.tests.failed ? `, УПАЛО ${s.tests.failed}` : ""}` : "";
    L.push(`${s.status.toUpperCase().padEnd(4)}  ${s.id.padEnd(24)} ${secs(s.ms).padStart(8)}${t}`);
    if (s.status !== "pass" && s.reason) L.push(`      причина: ${s.reason}`);
    if (s.status === "fail") for (const n of (s.notes ?? []).slice(0, 8)) L.push(`      · ${n}`);
  }
  const a = r.audit;
  L.push("", `аудит «зелёный ≠ проверено»: пропущено тестов ${a.skippedTests}, пропущено шагов ${a.skippedSteps.length}`);
  for (const u of a.unverified.slice(0, 25)) L.push(`  ? ${u}`);
  if (a.unverified.length > 25) L.push(`  ? … ещё ${a.unverified.length - 25} (полный список — в JSON)`);
  const sk = r.steps.flatMap((s) => (s.skipped ?? []).map((t) => `  - ${t.file} > ${t.name}\n      ${t.reason}`));
  if (sk.length) L.push("", "пропущенные тесты и их условия:", ...sk.slice(0, 20), ...(sk.length > 20 ? [`  … ещё ${sk.length - 20}`] : []));
  return L.join("\n");
}
