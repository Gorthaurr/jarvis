import { afterEach, describe, expect, it } from "vitest";
import type { CodeRequest } from "./service-code-exec.js";
import { resetServiceOptions } from "./service-handlers.js";
import { errOf, rig } from "./service-rig.js";

afterEach(() => resetServiceOptions());

const run = (code: string, extra: Record<string, unknown> = {}) => ({ kind: "code.run" as const, lang: "node" as const, code, ...extra });

describe("code.run по умолчанию", () => {
  it("выключен: честный runtime-отказ, ничего не выполнялось и в журнале пусто", async () => {
    const r = rig();
    const res = await r.call(run("console.log(1)"));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("runtime");
    expect(errOf(res)).toContain("code.run отключён в лаборатории");
    expect(r.core.effects).toHaveLength(0);
    expect(errOf(await r.call({ kind: "job.status", jobId: "job-1" }))).toContain("неизвестно");
  });

  it("фоновый запуск тоже выключен (задание не создаётся)", async () => {
    const r = rig();
    const res = await r.call(run("1", { background: true }));
    expect(res.ok).toBe(false);
    expect(r.kinds("code.job.start")).toHaveLength(0);
  });
});

describe("code.run со сценарным исполнителем", () => {
  const seen: CodeRequest[] = [];
  const exec = (out: Partial<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; durationMs: number }>) => ({
    run: async (req: CodeRequest) => (seen.push(req), { stdout: "", stderr: "", exitCode: 0, truncated: false, ...out }),
  });

  it("успех: форма данных как у клиента, эффект записан", async () => {
    const r = rig(undefined, { codeExecutor: exec({ stdout: "42\n" }) });
    const res = await r.call(run("print(42)"));
    expect(res).toMatchObject({ ok: true, data: { stdout: "42\n", stderr: "", exitCode: 0, truncated: false } });
    expect(r.kinds("code.run")[0]).toMatchObject({ lang: "node", exitCode: 0 });
  });

  it("ненулевой exitCode — это runtime, а не «успех с exitCode»; stderr и stdout в тексте", async () => {
    const r = rig(undefined, { codeExecutor: exec({ exitCode: 3, stderr: "boom", stdout: "part" }) });
    const res = await r.call(run("x"));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("runtime");
    expect(errOf(res)).toMatch(/код завершился с кодом 3\. stderr: boom \| stdout: part/u);
  });

  it("таймаут назван таймаутом, а не просто «прервано»", async () => {
    const r = rig(undefined, { codeExecutor: exec({ exitCode: -1, timedOut: true }) });
    expect(errOf(await r.call(run("x")))).toContain("ТАЙМАУТ");
  });

  it("окно запуска клампится [1 с, 180 с], по умолчанию 30 с", async () => {
    seen.length = 0;
    const r = rig(undefined, { codeExecutor: exec({}) });
    await r.call(run("a", { timeoutMs: 999_999 }));
    await r.call(run("b", { timeoutMs: 5 }));
    await r.call(run("c"));
    expect(seen.map((s) => s.timeoutMs)).toEqual([180_000, 1_000, 30_000]);
  });

  it("cwd: несуществующий виртуальный каталог — ошибка, существующий — принимается", async () => {
    const r = rig({ files: { "proj/a.txt": "x" } }, { codeExecutor: exec({}) });
    expect(errOf(await r.call(run("x", { cwd: "nope" })))).toContain("не существует");
    expect(errOf(await r.call(run("x", { cwd: "proj/a.txt" })))).toContain("не каталог");
    expect((await r.call(run("x", { cwd: "proj" }))).ok).toBe(true);
  });

  it("фон: сразу jobId, потом job.status по виртуальному времени, kill останавливает", async () => {
    const r = rig(undefined, { codeExecutor: exec({ stdout: "done", durationMs: 5000 }) });
    const start = await r.call(run("long", { background: true }));
    expect(start).toMatchObject({ ok: true, data: { jobId: "job-1", background: true } });
    await Promise.resolve();
    r.core.advance(1000);
    const mid = (await r.call({ kind: "job.status", jobId: "job-1" })).data as Record<string, unknown>;
    expect(mid).toMatchObject({ running: true, elapsedMs: 1000 });
    expect(mid.exitCode).toBeUndefined();
    r.core.advance(4000);
    const end = (await r.call({ kind: "job.status", jobId: "job-1" })).data as Record<string, unknown>;
    expect(end).toMatchObject({ running: false, exitCode: 0, stdoutTail: "done", killed: false });

    const j2 = ((await r.call(run("long2", { background: true }))).data as { jobId: string }).jobId;
    await Promise.resolve();
    const killed = (await r.call({ kind: "job.status", jobId: j2, kill: true })).data as Record<string, unknown>;
    expect(killed).toMatchObject({ running: false, killed: true, exitCode: -1 });
    expect(r.kinds("code.job.kill")).toEqual([{ jobId: j2 }]);
  });

  it("не больше 4 фоновых заданий одновременно", async () => {
    const r = rig(undefined, { codeExecutor: exec({ durationMs: 60_000 }) });
    for (let i = 0; i < 4; i += 1) expect((await r.call(run("x", { background: true }))).ok).toBe(true);
    const fifth = await r.call(run("x", { background: true }));
    expect(fifth.ok).toBe(false);
    expect(errOf(fifth)).toContain("уже идут 4 фоновых заданий");
  });
});

describe("code.run реальным интерпретатором (allowCodeExec)", () => {
  it("исполняет в своей tmp-папке и НЕ отдаёт коду секреты окружения", async () => {
    process.env.LAB_TEST_SECRET_TOKEN = "s3cr3t-value";
    try {
      const r = rig(undefined, { allowCodeExec: true });
      const res = await r.call(run("console.log(String(process.env.LAB_TEST_SECRET_TOKEN)); console.log(process.cwd()); console.log(process.env.HOME === process.env.TEMP)"));
      expect(res.ok).toBe(true);
      const out = (res.data as { stdout: string }).stdout.split(/\r?\n/u);
      expect(out[0]).toBe("undefined");
      expect(out[1]).toMatch(/jarvis-lab-code-/u);
      expect(out[2]).toBe("true");
    } finally {
      delete process.env.LAB_TEST_SECRET_TOKEN;
    }
  }, 30_000);

  it("падение скрипта — runtime со stderr; вечный скрипт убивается по таймауту", async () => {
    const r = rig(undefined, { allowCodeExec: true });
    const bad = await r.call(run("console.error('bad'); process.exit(2)"));
    expect(bad.ok).toBe(false);
    expect(errOf(bad)).toMatch(/кодом 2\. stderr: bad/u);
    const hang = await r.call(run("setTimeout(() => {}, 60000)", { timeoutMs: 1000 }));
    expect(hang.ok).toBe(false);
    expect(errOf(hang)).toContain("ТАЙМАУТ");
  }, 30_000);

  it("реальное фоновое задание завершается и job.status отдаёт вывод", async () => {
    const r = rig(undefined, { allowCodeExec: true });
    const start = (await r.call(run("console.log('hi-job')", { background: true }))).data as { jobId: string };
    let st = (await r.call({ kind: "job.status", jobId: start.jobId })).data as { running: boolean; stdoutTail: string; exitCode?: number };
    for (let i = 0; i < 100 && st.running; i += 1) {
      await new Promise((res) => setTimeout(res, 100));
      st = (await r.call({ kind: "job.status", jobId: start.jobId })).data as typeof st;
    }
    expect(st).toMatchObject({ running: false, exitCode: 0 });
    expect(st.stdoutTail).toContain("hi-job");
  }, 30_000);
});
