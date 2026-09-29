import { describe, expect, it } from "vitest";
import { runExec } from "./exec.js";

const node = process.execPath;
const run = (code: string, timeoutMs = 10_000, cap?: number, env?: Record<string, string>) =>
  runExec({ cmd: node, args: ["-e", code], cwd: process.cwd(), timeoutMs, env }, cap);

describe("runExec (настоящие дочерние процессы)", () => {
  it("код выхода и вывод stdout+stderr", async () => {
    const r = await run('console.log("out-line"); console.error("err-line"); process.exit(3)');
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.out).toContain("out-line");
    expect(r.out).toContain("err-line");
  });

  it("таймаут убивает процесс: быстро, timedOut=true", async () => {
    const t0 = Date.now();
    const r = await run("setTimeout(() => {}, 20000)", 400);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(8_000);
    expect(r.code === 0).toBe(false);
  });

  it("таймаут убивает и ВНУКА (дерево), иначе воркеры vitest остаются сиротами", async () => {
    const code = `const {spawn}=require("node:child_process");
      const c=spawn(process.execPath,["-e","setTimeout(()=>{},20000)"],{stdio:"ignore"});
      console.log("GRANDCHILD="+c.pid); setTimeout(()=>{},20000)`;
    const r = await run(code, 1500);
    const pid = Number(/GRANDCHILD=(\d+)/u.exec(r.out)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 500));
    const alive = ((): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } })();
    expect(alive).toBe(false);
  });

  it("длинный вывод усекается с начала: хвост (итоги) сохранён, truncated=true", async () => {
    const r = await run('for (let i = 0; i < 20000; i++) console.log("line-" + i); console.log("THE-END")', 20_000, 50_000);
    expect(r.truncated).toBe(true);
    expect(r.out.length).toBeLessThanOrEqual(50_000);
    expect(r.out).toContain("THE-END");
    expect(r.out).not.toContain("line-0\n");
  });

  it("env передаётся дочернему; FORCE_COLOR отключён", async () => {
    const r = await run('console.log("V=" + process.env.LAB_VERIFY_X + " C=" + process.env.FORCE_COLOR)', 10_000, undefined, { LAB_VERIFY_X: "42" });
    expect(r.out).toContain("V=42 C=0");
  });

  it("несуществующая команда → code=null и причина в выводе, без исключения", async () => {
    const r = await runExec({ cmd: "definitely-not-a-command-xyz", args: [], cwd: process.cwd(), timeoutMs: 5000 });
    expect(r.code).toBeNull();
    expect(r.out).toContain("не удалось запустить");
  });
});
