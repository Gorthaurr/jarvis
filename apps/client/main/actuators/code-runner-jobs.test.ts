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

describe("code-runner — кодировка python и хвост stdout (контроль-7 sdk-1/sdk-4)", () => {
  it("sdk-1: кириллица в stderr/stdout python читается БЕЗ ручного PYTHONIOENCODING (раннер выставляет utf-8 сам)", async () => {
    // Окружение теста могло унаследовать PYTHONIOENCODING от оболочки — снимаем, чтобы проверять РАННЕР, а не среду
    // (первый прогон мутации был «декоративным» ровно из-за такого наследования).
    const saved = { io: process.env.PYTHONIOENCODING, utf8: process.env.PYTHONUTF8 };
    delete process.env.PYTHONIOENCODING;
    delete process.env.PYTHONUTF8;
    try {
      const r = await run("python", ["import sys", "sys.stderr.write('причина: оверлей')", "print('мир')"].join("\n"), { timeoutMs: 20_000 });
      expect(r.stderr).toContain("причина: оверлей"); // до фикса: cp1251-байты, декодированные как utf8 — моджибейк в причине остановки
      expect(r.stdout).toContain("мир");
    } finally {
      if (saved.io !== undefined) process.env.PYTHONIOENCODING = saved.io;
      if (saved.utf8 !== undefined) process.env.PYTHONUTF8 = saved.utf8;
    }
  }, 30_000);

  it("контроль-8 (pythonutf8-scope): раннер чинит кодировку ПОТОКОВ, но не ломает чтение cp1251-файлов скриптом", async () => {
    const cpDir = await fsp.mkdtemp(join(tmpdir(), "jarvis-cp1251-"));
    const file = join(cpDir, "win.txt");
    await fsp.writeFile(file, Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])); // «Привет» в cp1251
    try {
      const code = ["import io, sys", `print(io.open(${JSON.stringify(file)}).read()[:6])`].join("\n");
      const r = await run("python", code, { timeoutMs: 20_000 });
      // До фикса: PYTHONUTF8=1 включал UTF-8 Mode → open() без encoding бросал UnicodeDecodeError, скрипт падал,
      // и петля читала это ПРОВАЛОМ МОДЕЛИ, хотя причина — среда.
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toMatch(/UnicodeDecodeError/u);
    } finally {
      await fsp.rm(cpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("sdk-4: stdout >64 КБ — голова капится, а stdoutTail несёт ФИНАЛЬНЫЙ print", async () => {
    const r = await run("python", ["import sys", "sys.stdout.write('x' * 70000)", "sys.stdout.write('\\nFINAL_LINE')"].join("\n"), { timeoutMs: 20_000 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.includes("FINAL_LINE")).toBe(false); // голова усечена — финала в ней нет
    expect((r.stdoutTail ?? "").trim().endsWith("FINAL_LINE")).toBe(true);
  }, 30_000);
});

describe("code-runner — stderr держится ХВОСТОМ (контроль-6 client:C5R-3)", () => {
  it("болтливый скрипт (>64 КБ в stderr) → маркер вуали в КОНЦЕ stderr переживает кап, exit 77 виден", async () => {
    const r = await run("python", ["import sys", "sys.stderr.write('x' * 70000)", "sys.stderr.write('\\n[overlay_drawing] done=0 injected=0 tail')", "sys.exit(77)"].join("\n"), { timeoutMs: 20_000 });
    expect(r.exitCode).toBe(77);
    expect(r.truncated).toBe(true);
    expect(r.stderr.endsWith("[overlay_drawing] done=0 injected=0 tail")).toBe(true); // до фикса: cap «головой» оставлял 64 КБ иксов, маркер терялся → runtime
  }, 30_000);
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

// Контроль-9 (job-caught-marker-lost-in-tail): маркер `[overlay_drawing]` печатается в момент raise, а хвост
// stderr — последние 4000 символов. Скрипт, перехвативший отказ вуали и напечатавший после этого больше
// предупреждений, выходил кодом 0 с маркером ЗА окном хвоста, и сервер читал задание чистым успехом.
describe("маркер вуали ищется во ВСЁМ stderr, а не в усечённом хвосте", () => {
  it("маркер в начале + 8000 символов шума после → overlayMarker есть, хвост его уже не содержит", async () => {
    const code = "import sys\nsys.stderr.write('[overlay_drawing] done=0 injected=0 input.click: оверлей\\n')\nsys.stderr.write('шум ' * 3000)\n";
    const j = await startJob("python", code);
    const s = await waitDone(j.jobId);
    expect(s.running).toBe(false);
    expect(s.stderrTail.includes("[overlay_drawing]")).toBe(false); // хвост маркер потерял — ровно случай дефекта
    expect(s.overlayMarker ?? "").toMatch(/\[overlay_drawing\] done=0 injected=0/u);
  });
});

// Контроль-10 (job-marker-first-not-last): маркер печатается на КАЖДЫЙ отказ вуали. Скрипт с бытовым `except:`
// печатает первый с done=0 и продолжает работу — по нему сервер говорил «уйти ничего не успело, запускай ЦЕЛИКОМ»
// поверх уже совершённых необратимых действий.
describe("маркер вуали берётся ПОСЛЕДНИЙ, а не первый", () => {
  it("два маркера в stderr → в overlayMarker попадает последний (done=5 injected=1)", async () => {
    const code =
      "import sys\n" +
      "sys.stderr.write('[overlay_drawing] done=0 injected=0 input.click: оверлей\\n')\n" +
      "sys.stderr.write('шум ' * 200)\n" +
      "sys.stderr.write('[overlay_drawing] done=5 injected=1 input.type: печать УЖЕ УШЛА\\n')\n";
    const j = await startJob("python", code);
    const s = await waitDone(j.jobId);
    expect(s.running).toBe(false);
    expect(s.overlayMarker ?? "").toMatch(/done=5 injected=1/u); // до фикса: done=0 injected=0
  });
});
