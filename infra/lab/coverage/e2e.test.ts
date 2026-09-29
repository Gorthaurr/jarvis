/**
 * Сквозная проверка на НАСТОЯЩЕМ репозитории: матрица собирается из кода, отчёт рендерится, а документированная команда CLI
 * (`node --import tsx infra/lab/coverage/cli.ts`) реально работает без флагов окружения.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../lib/deps.js";
import { buildCoverage } from "./matrix.js";
import { renderMarkdown } from "./render.js";

describe("buildCoverage на репозитории", () => {
  it("строки = инструменты + виды команд + интенты; кейсы лаборатории засчитаны прошедшими", async () => {
    const rep = await buildCoverage();
    const t = rep.matrix.totals;
    expect(t.rows).toBe((t["kind:tool"] ?? 0) + (t["kind:action"] ?? 0) + (t["kind:intent"] ?? 0));
    expect(t["kind:tool"]).toBeGreaterThan(100);
    expect(t["kind:action"]).toBe(59);
    const fsDelete = rep.matrix.rows.find((r) => r.id === "tool:fs_delete")!;
    expect(fsDelete.coveredBy).toContain("lab-tool");
    // uncovered согласован со строками: ровно те, у кого только none
    expect(rep.matrix.uncovered.sort()).toEqual(rep.matrix.rows.filter((r) => r.coveredBy.join() === "none").map((r) => r.id).sort());
    expect(rep.warnings.filter((w) => /coversTool|не загружены|несуществующую/.test(w))).toEqual([]);
  }, 60_000);

  it("статический режим (без прогона) засчитывает не меньше, чем прогон", async () => {
    const [ran, stat] = [await buildCoverage(), await buildCoverage({ runCases: false })];
    expect(stat.matrix.totals["cover:lab-tool"] ?? 0).toBeGreaterThanOrEqual(ran.matrix.totals["cover:lab-tool"] ?? 0);
  }, 60_000);

  it("markdown содержит итоги, список непокрытого и таблицы по трём видам строк", async () => {
    const md = renderMarkdown(await buildCoverage({ runCases: false }));
    for (const h of ["# Матрица покрытия", "## Итого", "## Не покрыто ничем", "## Инструменты", "## Виды команд клиенту", "## Интенты tier0"]) expect(md).toContain(h);
    expect(md).toMatch(/\| `fs_delete` \|/);
    expect(md).toMatch(/\| `fs\.write` \|/);
  }, 60_000);
});

describe("CLI", () => {
  it("документированная команда работает без окружения и пишет файл (--out)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lab-cov-cli-"));
    const out = join(dir, "COVERAGE.md");
    try {
      execFileSync(process.execPath, ["--import", "tsx", "infra/lab/coverage/cli.ts", "--no-run", "--out", out], { cwd: ROOT, stdio: "pipe", timeout: 90_000 });
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out, "utf8")).toContain("# Матрица покрытия");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("--json печатает чистый JSON (логи сервера не портят stdout)", () => {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", "infra/lab/coverage/cli.ts", "--no-run", "--json"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 }).toString("utf8");
    const rep = JSON.parse(stdout) as { matrix: { rows: unknown[] } };
    expect(rep.matrix.rows.length).toBeGreaterThan(150);
  }, 120_000);
});
