/**
 * W2 П2 (§0) — СКВОЗНОЙ: НАСТОЯЩИЙ python (jarvis SDK) → НАСТОЯЩИЙ loopback-мост → НАСТОЯЩИЙ dispatch актуаторов →
 * рубеж инжекции → фейковый сайдкар в реальной форме (снапшот handle числом, value «•••» у поля IsPassword).
 * `jarvis.find("Пароль").click()` → `jarvis.write("x")`: клик ушёл (UIA invoke), печать — denied, в сайдкар не дошла.
 * Реверт-проверка: память клика не пишется (noteInjected без invoke) при лёгшем read.screen → «x» напечатан;
 * судья secret — заглушка → оба кейса печатают.
 * Мост живёт в ТОМ ЖЕ event loop, что и тест → python запускается асинхронно (как jarvis-sdk-veil). Без python — пропуск.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSidecar } from "../test-support/fake-sidecar.js";

vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());

import { useFakeSidecar } from "../test-support/fake-sidecar.js";
import { resetElectronMock } from "../test-support/electron-mock.js";
import { selectionStore } from "../selection/store.js";
import { dispatch } from "./index.js";
import { type ActBridge, startActBridge } from "./act-bridge.js";
import { JARVIS_SDK_PY } from "./jarvis-sdk-source.js";
import { resetHeldKeys } from "./input.js";
import { resetMirror } from "./handle-mirror.js";
import { resetSecretMemory } from "./secret-memory.js";
import { resetFieldCache } from "./focused-field.js";

const hasPython = (() => {
  try {
    return spawnSync("python", ["--version"], { encoding: "utf8", timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
})();

let fake: FakeSidecar;
let bridge: ActBridge | null = null;
let sdkDir = "";
const prevObserve = process.env.JARVIS_FUSED_OBSERVE;

function py(lines: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-c", lines.join("\n")], {
      env: { ...process.env, JARVIS_ACT_URL: `http://127.0.0.1:${bridge!.port}/act`, JARVIS_ACT_TOKEN: bridge!.token, PYTHONPATH: sdkDir, PYTHONIOENCODING: "utf-8" },
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

describe.skipIf(!hasPython)("jarvis SDK × §0 (настоящий python + мост + dispatch)", () => {
  beforeAll(async () => {
    process.env.JARVIS_FUSED_OBSERVE = "0";
    sdkDir = mkdtempSync(join(tmpdir(), "jarvis-sdk-secret-"));
    writeFileSync(join(sdkDir, "jarvis.py"), JARVIS_SDK_PY, "utf8");
    bridge = await startActBridge(dispatch);
  });
  afterAll(async () => {
    await bridge?.stop();
    rmSync(sdkDir, { recursive: true, force: true });
    if (prevObserve === undefined) delete process.env.JARVIS_FUSED_OBSERVE;
    else process.env.JARVIS_FUSED_OBSERVE = prevObserve;
  });
  beforeEach(() => {
    fake = useFakeSidecar();
    fake.snapshot = {
      window: "Вход — Банк",
      pid: 700,
      items: [
        { handle: 6, role: "edit", name: "Логин", value: "", x: 100, y: 50, w: 200, h: 30 },
        { handle: 7, role: "edit", name: "Пароль", value: "•••", x: 100, y: 100, w: 200, h: 30 },
      ],
      truncated: false,
    };
    fake.windows = [{ hwnd: 70, pid: 700, process: "bank", title: "Вход — Банк", foreground: true, x: 0, y: 0, w: 800, h: 600 }];
    resetElectronMock();
    resetHeldKeys();
    resetMirror();
    resetSecretMemory();
    resetFieldCache();
    selectionStore.setDrawing(false);
  });

  it("find('Пароль').click() → write('x') при лёгшем read.screen (UIA Electron): клик ушёл, печать denied по памяти клика", async () => {
    fake.handlers["read.screen"] = () => {
      throw new Error("UIA timeout");
    };
    const r = await py(["import jarvis", "jarvis.find('Пароль').click()", "print('clicked', flush=True)", "jarvis.write('x')", "print('typed')"]);
    expect(r.stdout).toMatch(/clicked/u);
    expect(r.stdout).not.toMatch(/typed/u);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/input\.type: §0: поле пароля\/кода/u);
    expect(fake.mutations().map((c) => c.op)).toEqual(["invoke"]);
  }, 40_000);

  it("то же при живом read.screen «[ЗАЩИЩЕНО]»; обычное поле «Логин» — печать уходит", async () => {
    fake.focusedText = "ControlType.Edit: Пароль [ЗАЩИЩЕНО]";
    const denied = await py(["import jarvis", "jarvis.find('Пароль').click()", "jarvis.write('x')"]);
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toMatch(/§0/u);
    fake.focusedText = "ControlType.Edit: Логин [ПУСТО]";
    const ok = await py(["import jarvis", "jarvis.find('Логин').click()", "jarvis.write('ivan')", "print('typed')"]);
    expect(ok.stdout).toMatch(/typed/u);
    // Интеграция W2 (стык П1×П2): find моста — лестница act (bridge-find), handle едет в форме протокола (строка,
    // Target.handle); сайдкар читает число из строки (Ipc.cs). Прежнее число — артефакт python-поиска до П1.
    expect(fake.mutations().map((c) => [c.op, c.args.text ?? c.args.handle])).toEqual([
      ["invoke", "7"],
      ["invoke", "6"],
      ["type", "ivan"],
    ]);
  }, 40_000);
});
