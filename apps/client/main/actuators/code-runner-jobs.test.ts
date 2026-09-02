/**
 * Причина №2 из USER_SCENARIOS_2026-09-02: code_run жил 30 с во временной папке без фоновых заданий —
 * тесты/сборки/деплой/транскрипция не влезали. Прогоны РЕАЛЬНЫЕ (node -e), без моков.
 */
import { afterAll, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveTimeoutMs, jobStatus, listJobs, run, startJob } from "./code-runner.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitDone(jobId: string, ms = 8_000) {
  const t0 = Date.now();
  for (;;) {
    const s = await jobStatus(jobId);
    if (!s.running || Date.now() - t0 > ms) return s;
    await sleep(100);
  }
}

let dir: string;
afterAll(async () => {
  if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("code-runner — cwd и timeoutMs", () => {
  it("cwd от модели уважается (скрипт видит именно этот каталог)", async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), "jarvis-cwd-"));
    const r = await run("node", "console.log(process.cwd())", { cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().toLowerCase()).toBe(dir.toLowerCase());
    expect(await fsp.stat(dir).then((s) => s.isDirectory())).toBe(true); // пользовательский cwd НЕ удаляется
  });

  it("несуществующий cwd → честная ошибка, а не молчаливая временная папка", async () => {
    await expect(run("node", "1", { cwd: join(tmpdir(), "jarvis-no-such-dir-xyz") })).rejects.toThrow(/не существует/u);
  });

  it("timeoutMs переопределяет окно: 1 с на 5-секундный скрипт → exitCode -1 быстро", async () => {
    const t0 = Date.now();
    const r = await run("node", "setTimeout(()=>{}, 5000)", { timeoutMs: 1000 });
    expect(r.exitCode).toBe(-1);
    expect(r.timedOut).toBe(true); // taskkill даёт код 1 — без флага таймаут был неотличим от падения
    expect(Date.now() - t0).toBeLessThan(4_500);
  });

  it("effectiveTimeoutMs клампит [1с, 180с], без opts — дефолт", () => {
    expect(effectiveTimeoutMs({ timeoutMs: 10 })).toBe(1_000);
    expect(effectiveTimeoutMs({ timeoutMs: 999_999 })).toBe(180_000);
    expect(effectiveTimeoutMs({ timeoutMs: 42_000 })).toBe(42_000);
    expect(effectiveTimeoutMs()).toBeGreaterThanOrEqual(5_000);
  });
});

describe("code-runner — фоновые задания", () => {
  it("startJob отдаёт jobId сразу; job_status: running → завершено с exitCode и хвостом stdout", async () => {
    const t0 = Date.now();
    const j = await startJob("node", "setTimeout(()=>{console.log('bg-done'); process.exit(0)}, 300)");
    expect(Date.now() - t0).toBeLessThan(2_000); // не ждали завершения
    expect(j.jobId).toMatch(/^job-/u);
    expect(j.pid).toBeGreaterThan(0);
    const first = await jobStatus(j.jobId);
    expect(first.running).toBe(true);
    expect(first.exitCode).toBeUndefined();
    const done = await waitDone(j.jobId);
    expect(done.running).toBe(false);
    expect(done.exitCode).toBe(0);
    expect(done.stdoutTail).toContain("bg-done");
    expect(listJobs().some((x) => x.jobId === j.jobId)).toBe(true);
  });

  it("ненулевой exit код доезжает честно (exitCode 3, stderr в хвосте)", async () => {
    const j = await startJob("node", "console.error('boom'); process.exit(3)");
    const done = await waitDone(j.jobId);
    expect(done.exitCode).toBe(3);
    expect(done.stderrTail).toContain("boom");
  });

  it("kill останавливает идущее задание: running:false, killed:true", async () => {
    const j = await startJob("node", "setInterval(()=>{}, 1000)");
    const s1 = await jobStatus(j.jobId);
    expect(s1.running).toBe(true);
    await jobStatus(j.jobId, true);
    const done = await waitDone(j.jobId, 5_000);
    expect(done.running).toBe(false);
    expect(done.killed).toBe(true);
  });

  it("неизвестный jobId → честная ошибка (реестр в памяти клиента)", async () => {
    await expect(jobStatus("job-nope")).rejects.toThrow(/неизвестно/u);
  });
});
