/**
 * code_run{cwd,timeoutMs,background} и job_status — проводка сервер→клиент через РЕАЛЬНЫЙ dispatchTool
 * (сценарии 2026-09-02, причина №2). Честность: фоновый запуск не рапортует «готово».
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { dispatchTool, type ToolContext } from "../dispatch.js";

type Send = (cmd: ActionCommand, timeoutMs?: number) => Promise<ActionResult>;
function ctxWith(sendAction: Send): ToolContext {
  return { session: { sendAction }, userId: "u1" } as unknown as ToolContext;
}

describe("code_run — cwd / timeoutMs / background", () => {
  it("cwd и timeoutMs доезжают до клиента; таймаут действия = timeoutMs + запас", async () => {
    const sendAction = vi.fn<Send>(async (cmd, timeoutMs) => {
      expect(cmd.kind).toBe("code.run");
      if (cmd.kind !== "code.run") throw new Error("unreachable");
      expect(cmd.cwd).toBe("C:\\repo");
      expect(cmd.timeoutMs).toBe(120_000);
      expect(cmd.background).toBeUndefined();
      expect(timeoutMs).toBe(125_000);
      return { commandId: "c", ok: true, data: { stdout: "ok", stderr: "", exitCode: 0, truncated: false }, durationMs: 1 };
    });
    const r = await dispatchTool("code_run", { lang: "node", code: "1", cwd: "C:\\repo", timeoutMs: 120000 }, ctxWith(sendAction));
    expect(r.isError).toBe(false);
    expect(sendAction).toHaveBeenCalledTimes(1);
  });

  it("background:true → короткий таймаут действия, ответ говорит «исход не известен», не «готово»", async () => {
    const sendAction = vi.fn<Send>(async (cmd, timeoutMs) => {
      if (cmd.kind !== "code.run") throw new Error("unreachable");
      expect(cmd.background).toBe(true);
      expect(timeoutMs).toBe(20_000);
      return { commandId: "c", ok: true, data: { jobId: "job-1", pid: 42, background: true }, durationMs: 1 };
    });
    const r = await dispatchTool("code_run", { lang: "powershell", code: "npm test", background: true }, ctxWith(sendAction));
    expect(r.isError).toBe(false);
    expect(String(r.content)).toContain("job-1");
    expect(String(r.content)).toMatch(/ИСХОД ЕЩЁ НЕ ИЗВЕСТЕН/u);
    expect(String(r.content)).toContain("job_status");
  });

  it("timeoutMs мусором → честная ошибка без похода к клиенту", async () => {
    const sendAction = vi.fn<Send>(async () => ({ commandId: "c", ok: true, durationMs: 1 }));
    const r = await dispatchTool("code_run", { lang: "node", code: "1", timeoutMs: "долго" }, ctxWith(sendAction));
    expect(r.isError).toBe(true);
    expect(sendAction).not.toHaveBeenCalled();
  });

  it("job_status{jobId, kill} → ActionCommand job.status; результат — JSON статуса", async () => {
    const sendAction = vi.fn<Send>(async (cmd) => {
      expect(cmd.kind).toBe("job.status");
      if (cmd.kind !== "job.status") throw new Error("unreachable");
      expect(cmd.jobId).toBe("job-1");
      expect(cmd.kill).toBe(true);
      return { commandId: "c", ok: true, data: { jobId: "job-1", running: false, exitCode: 0, stdoutTail: "done" }, durationMs: 1 };
    });
    const r = await dispatchTool("job_status", { jobId: "job-1", kill: true }, ctxWith(sendAction));
    expect(r.isError).toBe(false);
    expect(String(r.content)).toContain('"running":false');
  });
});
