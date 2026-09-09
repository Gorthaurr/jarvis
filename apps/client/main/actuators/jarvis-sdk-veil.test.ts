/**
 * jarvis SDK × вуаль режима выделения — НАСТОЯЩИЙ python против НАСТОЯЩЕГО loopback-моста (контроль-5, ACT-3/ACT-4).
 *
 * Что охраняет (реверт-проверка — что сломать):
 *  • find() под вуалью бросает, а не отдаёт пустой Element («не нашёл» = ложная причина)  → убрать raise veil в find();
 *  • отказ вуали завершает скрипт ВЫДЕЛЕННЫМ кодом 77 (структурный сигнал для code.run)     → убрать sys.excepthook;
 *  • перехваченный отказ + своё падение позже = обычный exit 1 (не вуаль)                   → os._exit(77) вне условия;
 *  • без вуали find() работает как раньше; wait_for отдаёт unknown/overlayDrawing скрипту.
 * Мост живёт в ТОМ ЖЕ event loop, что и тест → python запускается АСИНХРОННО (spawnSync заблокировал бы мост,
 * и python ждал бы ответа вечно — первая версия теста именно так и висела). Без python в среде кейсы пропускаются.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { type ActBridge, startActBridge } from "./act-bridge.js";
import { JARVIS_SDK_PY } from "./jarvis-sdk-source.js";

const hasPython = (() => {
  try {
    return spawnSync("python", ["--version"], { encoding: "utf8", timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
})();

let veil = true;
/** Контроль-6 (V5-2): сколько кликов под вуалью ещё «проходят» (вуаль открылась ПОСЛЕ них). */
let clicksBeforeVeil = 0;
let bridge: ActBridge | null = null;
let sdkDir = "";

function res(commandId: string, data: unknown): ActionResult {
  return { commandId, ok: true, data, durationMs: 1 };
}

const dispatch = async (commandId: string, cmd: ActionCommand): Promise<ActionResult> => {
  const mark = veil ? { overlayDrawing: true, overlayNote: "поверх экрана вуаль" } : {};
  switch (cmd.kind) {
    case "ui.snapshot":
      return res(commandId, { items: [{ handle: "1", role: "button", name: "OK" }], ...mark });
    case "screen.ocr":
      return res(commandId, { text: "", lines: [], ...mark });
    case "wait.for":
      return res(commandId, { met: false, unknown: true, ...mark });
    case "input.click":
      if (veil && clicksBeforeVeil > 0) {
        clicksBeforeVeil -= 1;
        return res(commandId, { clicked: true });
      }
      return veil
        ? { commandId, ok: false, error: { code: "overlay_drawing", message: "Поверх экрана открыт оверлей режима выделения (уже 2 с)" }, durationMs: 1 }
        : res(commandId, { clicked: true });
    case "input.type":
      return veil
        ? { commandId, ok: false, error: { code: "overlay_drawing", message: "Печать текста УЖЕ УШЛО в GUI, когда открылся оверлей" }, stepActionInjected: true, durationMs: 1 }
        : res(commandId, { typed: true });
    default:
      return { commandId, ok: false, error: { code: "runtime", message: `unexpected ${cmd.kind}` }, durationMs: 1 };
  }
};

type Run = { status: number | null; stdout: string; stderr: string };

function py(lines: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-c", lines.join("\n")], {
      env: {
        ...process.env,
        JARVIS_ACT_URL: `http://127.0.0.1:${bridge!.port}/act`,
        JARVIS_ACT_TOKEN: bridge!.token,
        PYTHONPATH: sdkDir,
        PYTHONIOENCODING: "utf-8",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

describe.skipIf(!hasPython)("jarvis SDK × вуаль (настоящий python + настоящий мост)", () => {
  beforeAll(async () => {
    sdkDir = mkdtempSync(join(tmpdir(), "jarvis-sdk-veil-"));
    writeFileSync(join(sdkDir, "jarvis.py"), JARVIS_SDK_PY, "utf8");
    bridge = await startActBridge(dispatch);
  });
  afterAll(async () => {
    await bridge?.stop();
    rmSync(sdkDir, { recursive: true, force: true });
  });

  it("ACT-3: find() под вуалью БРОСАЕТ (снапшот/OCR показывают оверлей — искать нечего), скрипт выходит кодом 77", async () => {
    veil = true;
    const r = await py(["import jarvis", "print(bool(jarvis.find('OK')))"]);
    expect(r.status).toBe(77); // до фикса: пустой Element → «не нашёл» → exit 0 и ложная причина модели
    expect(r.stderr).toMatch(/\[overlay_drawing\]/u);
    expect(r.stdout).not.toMatch(/True|False/u);
  });

  it("ACT-4: отказ вуали на клике завершает скрипт кодом 77 (структурный сигнал для code.run), маркер с done= — в stderr", async () => {
    veil = true;
    const r = await py(["import jarvis", "jarvis.click(1, 2)"]);
    expect(r.status).toBe(77);
    expect(r.stderr).toMatch(/\[overlay_drawing\] done=0 injected=0 input\.click/u);
  });

  it("контроль-6 (client:C5R-3): типовая обёртка «except Exception» НЕ съедает вуаль — JarvisVeilExit это SystemExit(77); finally/with отрабатывают", async () => {
    veil = true;
    const out = join(sdkDir, "written.txt");
    const r = await py([
      "import jarvis",
      `f = open(${JSON.stringify(out)}, 'w', encoding='utf-8')`,
      "try:",
      "    with f:",
      "        f.write('данные')",
      "        jarvis.click(1, 2)",
      "except Exception as e:",
      "    print('swallowed', e)",
      "    raise SystemExit(1)",
    ]);
    expect(r.status).toBe(77); // до фикса: except Exception ловил JarvisError → exit 1 → сервер читал «провал модели»
    expect(r.stdout).not.toMatch(/swallowed/u);
    expect(r.stderr).toMatch(/\[overlay_drawing\] done=0/u);
    expect(readFileSync(out, "utf8")).toBe("данные"); // os._exit(77) минул бы закрытие файла — буфер остался бы пустым
  });

  it("ACT-4b: скрипт, ЯВНО поймавший вуаль (except BaseException) и упавший позже сам, = обычный exit 1, не «остановлен вуалью»", async () => {
    veil = true;
    const r = await py(["import jarvis", "try:", "    jarvis.click(1, 2)", "except BaseException as e:", "    print(getattr(e, 'jarvis_code', None), e)", "raise KeyError('items')"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/overlay_drawing/u); // атрибуты у исключения есть — скрипт может ждать/решать сам
    expect(r.stderr).toMatch(/\[overlay_drawing\]/u); // маркер напечатан В МОМЕНТ raise — но без exit 77 это не код вуали
  });

  it("контроль-6 (V5-2): два клика ушли, третий лёг об вуаль → маркер несёт done=2; печать, ушедшая под вуаль, — injected=1", async () => {
    veil = true;
    clicksBeforeVeil = 2;
    const r = await py(["import jarvis", "jarvis.click(1, 2)", "jarvis.click(3, 4)", "jarvis.click(5, 6)"]);
    expect(r.status).toBe(77);
    expect(r.stderr).toMatch(/\[overlay_drawing\] done=2 injected=0 input\.click/u); // до фикса: done не считался — сервер говорил «действие не выполнено» про два ушедших клика
    clicksBeforeVeil = 1;
    const t = await py(["import jarvis", "jarvis.click(1, 2)", "jarvis.write('привет')"]);
    expect(t.status).toBe(77);
    expect(t.stderr).toMatch(/\[overlay_drawing\] done=1 injected=1 input\.type/u);
  });

  it("контроль-6 (C5R-5): snapshot(pid=…) чужого окна под вуалью НЕ бросает — его UIA-дерево не оверлей", async () => {
    veil = true;
    const r = await py(["import jarvis", "print(len(jarvis.snapshot(pid=4242)['items']))"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("1");
  });

  it("без вуали find() находит элемент; wait_for под вуалью отдаёт unknown/overlayDrawing скрипту (не бросает — им можно ждать)", async () => {
    veil = false;
    const ok = await py(["import jarvis", "print(bool(jarvis.find('OK')))"]);
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toBe("True");
    veil = true;
    const w = await py(["import jarvis", "r = jarvis.wait_for({'kind': 'window', 'titleContains': 'x'}, timeout=1)", "print(r.get('unknown'), r.get('overlayDrawing'))"]);
    expect(w.status).toBe(0);
    expect(w.stdout.trim()).toBe("True True");
  });
});
