/**
 * Раннер кейсов инструментов: каждый кейс — СВОЯ лаборатория (свой «ПК», свои сторы), вызов через настоящий dispatchTool,
 * проверка по факту. Кейс, которому нужен вид команд, что FakeDesktop ещё не умеет, честно ПРОПУСКАЕТСЯ с причиной
 * (не «зелёный»): как только обработчик появится, кейс оживает сам.
 */
import { ACTUATOR_KIND_BY_TOOL, canonicalToolCall } from "../../../packages/tools/src/index.js";
import { supportedKinds } from "../desktop/index.js";
import { type ToolCase, caseId } from "./case-format.js";
import { evaluate } from "./expect.js";
import type { DesktopSeed, FakeDesktop } from "../lib/contracts.js";
import { type ToolCallOutcome, createToolLab } from "./harness.js";

export type CaseStatus = "pass" | "fail" | "skip" | "error";

export interface CaseResult {
  id: string;
  tool: string;
  name: string;
  coversTool: string;
  status: CaseStatus;
  failures: string[];
  skipReason?: string;
  ms: number;
  /** Что реально произошло (для отчёта); нет — кейс не запускался. */
  seen?: { isError: boolean; text: string; flags: Record<string, boolean | string>; actionKinds: string[]; asked: number; effects: number };
}

/** Виды команд FakeDesktop, без которых кейс бессмыслен. */
export function requiredKinds(c: ToolCase): string[] {
  if (c.needsKinds) return c.needsKinds;
  const kinds = new Set<string>(c.expect.actionKinds ?? []);
  for (const s of c.before ?? []) {
    const k = ACTUATOR_KIND_BY_TOOL[canonicalToolCall(s.tool, s.args ?? {}).name];
    if (k) kinds.add(k);
  }
  return [...kinds];
}

/** Причина пропуска (ручной skip или неподдержанные FakeDesktop виды); null — запускать. */
export function skipReasonOf(c: ToolCase, supported: ReadonlySet<string>): string | null {
  if (c.skip) return c.skip;
  const missing = requiredKinds(c).filter((k) => !supported.has(k));
  return missing.length ? `FakeDesktop ещё не умеет: ${missing.join(", ")}` : null;
}

const base = (c: ToolCase) => ({ id: caseId(c), tool: c.tool, name: c.name, coversTool: c.coversTool });
const clip = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function seenOf(o: ToolCallOutcome): NonNullable<CaseResult["seen"]> {
  return { isError: o.isError, text: clip(o.text), flags: o.flags, actionKinds: o.actions.map((a) => a.cmd.kind), asked: o.asked.length, effects: o.effects.length };
}

export interface RunOptions {
  /** Поддерживаемые виды команд (по умолчанию — из FakeDesktop). */
  supported?: ReadonlySet<string>;
  /** Подмена «ПК» (тесты самого раннера); по умолчанию — настоящий FakeDesktop из seed кейса. */
  makeDesktop?: (seed?: DesktopSeed) => FakeDesktop;
}

export async function runCase(c: ToolCase, opts: RunOptions = {}): Promise<CaseResult> {
  const skip = skipReasonOf(c, opts.supported ?? new Set(supportedKinds()));
  if (skip) return { ...base(c), status: "skip", failures: [], skipReason: skip, ms: 0 };
  const t0 = Date.now();
  const lab = createToolLab({ ...(c.seed ? { seed: c.seed } : {}), ...(opts.makeDesktop ? { desktop: opts.makeDesktop(c.seed) } : {}), ...(c.lab ?? {}) });
  try {
    for (const s of c.before ?? []) {
      const b = await lab.call(s.tool, s.args ?? {}, s.confirm !== undefined ? { confirm: s.confirm } : {});
      if (b.isError) return { ...base(c), status: "error", failures: [`предусловие ${s.tool} не выполнилось: ${clip(b.text)}`], ms: Date.now() - t0 };
    }
    const out = await lab.call(c.tool, c.args ?? {}, c.confirm !== undefined ? { confirm: c.confirm } : {});
    const failures = evaluate(c.expect, out);
    return { ...base(c), status: failures.length ? "fail" : "pass", failures, ms: Date.now() - t0, seen: seenOf(out) };
  } catch (e) {
    return { ...base(c), status: "error", failures: [`исключение: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`], ms: Date.now() - t0 };
  } finally {
    await lab.close();
  }
}

/** Последовательно (env процесса глобален — параллельные лабы делили бы пути данных). */
export async function runCases(cases: readonly ToolCase[], opts: RunOptions = {}): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const c of cases) out.push(await runCase(c, opts));
  return out;
}

export function summarize(rs: readonly CaseResult[]): Record<CaseStatus | "total", number> {
  const s = { pass: 0, fail: 0, skip: 0, error: 0, total: rs.length };
  for (const r of rs) s[r.status] += 1;
  return s;
}

const MARK: Record<CaseStatus, string> = { pass: "PASS", fail: "FAIL", skip: "skip", error: "ERR " };

/** Текстовая таблица для терминала. */
export function formatTable(rs: readonly CaseResult[]): string {
  const w = Math.max(10, ...rs.map((r) => r.id.length));
  const lines = rs.map((r) => {
    const why = r.status === "skip" ? r.skipReason : r.failures[0];
    return `${MARK[r.status]}  ${r.id.padEnd(w)}  ${String(r.ms).padStart(5)}ms${why ? `  ${why}` : ""}`;
  });
  const s = summarize(rs);
  return `${lines.join("\n")}\n\nитого: ${s.total} | pass ${s.pass} | fail ${s.fail} | error ${s.error} | skip ${s.skip}`;
}

export function toJson(rs: readonly CaseResult[]): { summary: ReturnType<typeof summarize>; cases: CaseResult[] } {
  return { summary: summarize(rs), cases: [...rs] };
}
