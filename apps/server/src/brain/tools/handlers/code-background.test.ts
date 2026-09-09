/**
 * code_run{cwd,timeoutMs,background} и job_status — проводка сервер→клиент через РЕАЛЬНЫЙ dispatchTool
 * (сценарии 2026-09-02, причина №2). Честность: фоновый запуск не рапортует «готово».
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { dispatchTool, type ToolContext } from "../dispatch.js";
import { overlayDeniedResult } from "../dispatch-util.js";

type Send = (cmd: ActionCommand, timeoutMs?: number) => Promise<ActionResult>;
function ctxWith(sendAction: Send): ToolContext {
  return { session: { sendAction }, userId: "u1" } as unknown as ToolContext;
}

// Контроль-6 (V5-2): клиент остановил скрипт SDK вуалью (код overlay_drawing + stepIndex = сделанные действия) — сервер
// обязан отдать ТОТ ЖЕ структурный признак, что у navыков/берста, а не «code.run не удалось» (провал модели для петли).
describe("code_run — остановка вуалью режима выделения", () => {
  it("overlay_drawing + stepIndex → overlayDenied/overlayStepIndex, текст без «не удалось»", async () => {
    const sendAction = vi.fn<Send>(async () => ({
      commandId: "c",
      ok: false,
      error: { code: "overlay_drawing", message: "скрипт остановлен: input.click: Поверх экрана открыт оверлей режима выделения Успешно ушедших действий до остановки: 2 — они НЕ откатываются." },
      stepIndex: 2,
      stepActionInjected: true,
      durationMs: 1,
    }));
    const r = await dispatchTool("code_run", { lang: "python", code: "import jarvis" }, ctxWith(sendAction));
    expect(r.isError).toBe(true);
    expect(r.overlayDenied).toBe(true);
    expect(r.overlayStepIndex).toBe(2);
    expect(r.overlayActionInjected).toBe(true);
    expect(String(r.content)).not.toMatch(/не удалось/u);
    expect(String(r.content)).toMatch(/остановлен/u);
  });

  it("контроль-8 (background-string-flag): background:\"true\" СТРОКОЙ — тот же «исход неизвестен», что у boolean (иначе голый spawn считался делом)", async () => {
    const sendAction = vi.fn<Send>(async () => ({ commandId: "c", ok: true, data: { jobId: "job-1", pid: 7 }, durationMs: 1 }));
    const r = await dispatchTool("code_run", { lang: "node", code: "build()", background: "true" }, ctxWith(sendAction));
    expect(r.uncertain).toBe(true);
    expect(r.jobId).toBe("job-1");
    const b = await dispatchTool("code_run", { lang: "node", code: "build()", background: true }, ctxWith(sendAction));
    expect(b.uncertain).toBe(true);
  });

  it("контроль-8 (job-status-injected / job-veil-done0-text): injected доезжает; при done=0 текст не обещает повтор несделанного", async () => {
    const withInjected = vi.fn<Send>(async () => ({
      commandId: "c",
      ok: true,
      data: { jobId: "job-1", running: false, exitCode: 77, overlayStopped: true, overlayReason: "input.type: печать УЖЕ УШЛА", overlayDone: 2, overlayInjected: true, stdoutTail: "typed" },
      durationMs: 1,
    }));
    const r = await dispatchTool("job_status", { jobId: "job-1" }, ctxWith(withInjected));
    expect(r.overlayDenied).toBe(true);
    expect(r.overlayActionInjected).toBe(true);
    expect(r.uncertain).toBe(true);
    expect(String(r.content)).toMatch(/УЖЕ УШЛО/u);

    const done0 = vi.fn<Send>(async () => ({
      commandId: "c",
      ok: true,
      data: { jobId: "job-1", running: false, exitCode: 77, overlayStopped: true, overlayReason: "input.click: оверлей", overlayDone: 0 },
      durationMs: 1,
    }));
    const z = await dispatchTool("job_status", { jobId: "job-1" }, ctxWith(done0));
    expect(String(z.content)).toMatch(/запустить заново ЦЕЛИКОМ/u);
    expect(String(z.content)).not.toMatch(/повторил бы их|продолжай с места остановки/u);
  });

  it("контроль-8 (background-caught-exit0 / -job-no-success): перехваченная вуаль → uncertain; завершение с кодом 0 → backgroundJob done; идёт → running", async () => {
    const caught = vi.fn<Send>(async () => ({
      commandId: "c",
      ok: true,
      data: { jobId: "job-1", running: false, exitCode: 0, overlayCaught: true, overlayReason: "input.click: оверлей" },
      durationMs: 1,
    }));
    const c = await dispatchTool("job_status", { jobId: "job-1" }, ctxWith(caught));
    expect(c.uncertain).toBe(true);
    expect(String(c.content)).toMatch(/ПЕРЕХВАТИЛО отказ вуали/u);

    const okDone = vi.fn<Send>(async () => ({ commandId: "c", ok: true, data: { jobId: "job-1", running: false, exitCode: 0, stdoutTail: "BUILD OK" }, durationMs: 1 }));
    expect((await dispatchTool("job_status", { jobId: "job-1" }, ctxWith(okDone))).backgroundJob).toBe("done");

    const running = vi.fn<Send>(async () => ({ commandId: "c", ok: true, data: { jobId: "job-1", running: true }, durationMs: 1 }));
    expect((await dispatchTool("job_status", { jobId: "job-1" }, ctxWith(running))).backgroundJob).toBe("running");
  });

  it("обычный провал скрипта (runtime) — прежний текст, без overlayDenied", async () => {
    const sendAction = vi.fn<Send>(async () => ({ commandId: "c", ok: false, error: { code: "runtime", message: "код завершился с кодом 1. stderr: KeyError" }, durationMs: 1 }));
    const r = await dispatchTool("code_run", { lang: "python", code: "x" }, ctxWith(sendAction));
    expect(r.overlayDenied).toBeUndefined();
    expect(String(r.content)).toMatch(/не удалось/u);
  });
});

// Контроль-7 (sdk-2): job_status остановленного вуалью задания — ТОТ ЖЕ структурный признак, что у синхронного code_run.
describe("job_status — остановка вуалью фонового задания", () => {
  it("overlayStopped/overlayDone → overlayDenied + overlayStepIndex; обычный статус — JSON как раньше", async () => {
    const sendAction = vi.fn<Send>(async () => ({
      commandId: "c",
      ok: true,
      data: { jobId: "job-1", lang: "python", running: false, exitCode: 77, elapsedMs: 5, stdoutTail: "clicked OK", stderrTail: "[overlay_drawing] done=2 injected=0 input.click: оверлей", overlayStopped: true, overlayReason: "input.click: оверлей", overlayDone: 2 },
      durationMs: 1,
    }));
    const r = await dispatchTool("job_status", { jobId: "job-1" }, ctxWith(sendAction));
    expect(r.isError).toBe(true);
    expect(r.overlayDenied).toBe(true);
    expect(r.overlayStepIndex).toBe(2);
    expect(String(r.content)).toMatch(/ОСТАНОВЛЕНО вуалью/u);
    expect(String(r.content)).toMatch(/clicked OK/u);
    const plain = vi.fn<Send>(async () => ({ commandId: "c", ok: true, data: { jobId: "job-1", running: true, elapsedMs: 5, stdoutTail: "", stderrTail: "" }, durationMs: 1 }));
    const p = await dispatchTool("job_status", { jobId: "job-1" }, ctxWith(plain));
    expect(p.isError).toBeFalsy();
    expect(p.overlayDenied).toBeUndefined();
    expect(String(p.content)).toContain("\"running\":true");
  });

  it("контроль-7 (loop-1, защита в глубину): overlayDeniedResult с ушедшим действием ставит uncertain — второй потребитель (журнал) видит «ИСХОД НЕИЗВЕСТЕН» и без partialCalls", () => {
    expect(overlayDeniedResult({ ok: false, error: { code: "overlay_drawing", message: "x" }, stepIndex: 1, stepActionInjected: true })?.uncertain).toBe(true);
    expect(overlayDeniedResult({ ok: false, error: { code: "overlay_drawing", message: "x" }, stepIndex: 1 })?.uncertain).toBeUndefined();
  });
});

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

// Контроль-9: текст остановки вуалью ветвится по ТРЁМ состояниям, а «убил задание» — сделанное дело.
describe("job_status — контроль-9", () => {
  const send = (data: Record<string, unknown>) => vi.fn<Send>(async () => ({ commandId: "c", ok: true, data, durationMs: 1 }));

  it("job-veil-done0-injected-contradiction: при done=0 с УШЕДШИМ действием текст не зовёт перезапустить ЦЕЛИКОМ", async () => {
    const r = await dispatchTool(
      "job_status",
      { jobId: "job-1" },
      ctxWith(send({ jobId: "job-1", running: false, exitCode: 77, overlayStopped: true, overlayReason: "input.click: клик УЖЕ УШЁЛ", overlayDone: 0, overlayInjected: true })),
    );
    const txt = String(r.content);
    expect(txt).toMatch(/УЖЕ УШЛО/u);
    expect(txt).not.toMatch(/уйти не успело/u); // до фикса: обе фразы стояли рядом
    expect(txt).not.toMatch(/ЦЕЛИКОМ\.?$|запустить заново ЦЕЛИКОМ/u); // и первая санкционировала дубль
    expect(r.overlayActionInjected).toBe(true);
  });

  it("job-veil-done0-not-failure: отчёт об остановленной процедуре структурен даже при done=0", async () => {
    const r = await dispatchTool(
      "job_status",
      { jobId: "job-1" },
      ctxWith(send({ jobId: "job-1", running: false, exitCode: 77, overlayStopped: true, overlayReason: "input.click: оверлей", overlayDone: 0 })),
    );
    expect(r.overlayProcedure).toBe(true); // до фикса: ни одного признака — петля считала ход успешным
    expect(r.overlayStepIndex).toBeUndefined(); // и врать про сделанные шаги мы не начали
  });

  it("job-kill-neutral-masked-failure: kill:true + killed → задание помечено «убито» (сделанное дело)", async () => {
    const r = await dispatchTool("job_status", { jobId: "job-1", kill: true }, ctxWith(send({ jobId: "job-1", running: true, killed: true, stdoutTail: "compiling" })));
    expect(r.backgroundJob).toBe("killed");
    const idle = await dispatchTool("job_status", { jobId: "job-1" }, ctxWith(send({ jobId: "job-1", running: true, killed: false })));
    expect(idle.backgroundJob).toBe("running"); // без просьбы убить — прежнее поведение
  });
});

// Контроль-10 (kill-label-over-done): просьба убить не стирает факт успешного завершения.
describe("job_status{kill} — контроль-10", () => {
  const send = (data: Record<string, unknown>) => vi.fn<Send>(async () => ({ commandId: "c", ok: true, data, durationMs: 1 }));

  it("задание успело собраться (exit 0, killed:false) → «done», а не «killed»", async () => {
    const r = await dispatchTool("job_status", { jobId: "job-1", kill: true }, ctxWith(send({ jobId: "job-1", running: false, exitCode: 0, killed: false })));
    expect(r.backgroundJob).toBe("done"); // до фикса: killed — неопределённость запуска не резолвилась никогда
  });

  it("реально убитое задание — «killed»", async () => {
    const r = await dispatchTool("job_status", { jobId: "job-1", kill: true }, ctxWith(send({ jobId: "job-1", running: true, killed: true })));
    expect(r.backgroundJob).toBe("killed");
  });
});
