/**
 * W2 П1: jarvis SDK × рубеж инжекции — НАСТОЯЩИЙ python против НАСТОЯЩЕГО моста и НАСТОЯЩЕГО actuators/dispatch
 * (фейковый сайдкар в реальной форме, мок Electron). python под prompt-injection — ровно тот вектор, ради которого рубеж.
 *
 * Реверт-проверка:
 *  - рубеж не судит мост (commit-judge → null)                   → «find("Отправить").click() в Telegram» (invoke уйдёт);
 *  - find берёт первое совпадение подстрокой (ui.find → старый find) → «Отправить файл» раньше «Отправить»;
 *  - click(space=None) снова по «последнему снимку»                → «click без space/frame».
 * Мост живёт в том же event loop, что и тест → python только асинхронно. Без python в среде — пропуск.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());
// OCR-ступень find (захват экрана Electron) на Linux недоступна — пустой экран в реальной форме OcrData.
vi.mock("./sensors-cheap.js", async (orig) => ({
  ...(await orig<typeof import("./sensors-cheap.js")>()),
  screenOcr: async () => ({ text: "", lines: [], width: 1920, height: 1080, mapping: { boundsX: 0, boundsY: 0, scale: 1 } }),
}));

import { type FakeSidecar, useFakeSidecar } from "../test-support/fake-sidecar.js";
import { resetElectronMock } from "../test-support/electron-mock.js";
import { TELEGRAM, el, front } from "../test-support/rubezh-fixtures.js";
import { type ActBridge, startActBridge } from "./act-bridge.js";
import { resetMirror } from "./handle-mirror.js";
import { dispatch } from "./index.js";
import { JARVIS_SDK_PY } from "./jarvis-sdk-source.js";

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

function py(lines: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, JARVIS_ACT_URL: `http://127.0.0.1:${bridge!.port}/act`, JARVIS_ACT_TOKEN: bridge!.token, PYTHONPATH: sdkDir, PYTHONIOENCODING: "utf-8" };
    const child = spawn("python", ["-c", lines.join("\n")], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("error", (e) => (clearTimeout(timer), reject(e)));
    child.on("close", (status) => (clearTimeout(timer), resolve({ status, stdout, stderr })));
  });
}

describe.skipIf(!hasPython)("jarvis SDK × рубеж инжекции (настоящий python + мост + dispatch)", () => {
  beforeAll(async () => {
    sdkDir = mkdtempSync(join(tmpdir(), "jarvis-sdk-rubezh-"));
    writeFileSync(join(sdkDir, "jarvis.py"), JARVIS_SDK_PY, "utf8");
    bridge = await startActBridge(dispatch);
  });
  afterAll(async () => {
    await bridge?.stop();
    rmSync(sdkDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    fake = useFakeSidecar();
    resetElectronMock();
    resetMirror();
    fake.windows = front(TELEGRAM);
    fake.snapshot = { window: TELEGRAM.title, pid: TELEGRAM.pid, items: [el(41, "Отправить")], truncated: false };
  });

  it("find(\"Отправить\").click() в Telegram → JarvisError denied (§14, мост не одобряет); invoke в сайдкар не ушёл", async () => {
    const r = await py(["import jarvis", "el = jarvis.find('Отправить')", "print('found', el.handle, el.name)", "try:", "    el.click()", "    print('CLICKED')", "except jarvis.JarvisError as e:", "    print('DENIED', getattr(e, 'code', ''), e)"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/found 41 Отправить/u);
    expect(r.stdout).toMatch(/DENIED denied .*§14/u);
    expect(r.stdout).not.toMatch(/CLICKED/u);
    expect(fake.count("invoke")).toBe(0);
    expect(fake.count("click")).toBe(0);
  });

  it("find ранжирует как act: [«Отправить файл», «Отправить»] → «Отправить»; два равных → JarvisError; нет — пустой Element", async () => {
    fake.snapshot.items = [el(40, "Отправить файл"), el(41, "Отправить")];
    const best = await py(["import jarvis", "print(jarvis.find('Отправить').handle)"]);
    expect(best.stdout.trim()).toBe("41");
    fake.snapshot.items = [el(41, "Отправить"), el(42, "Отправить")];
    const tie = await py(["import jarvis", "try:", "    jarvis.find('Отправить')", "except jarvis.JarvisError as e:", "    print('ERR', e)"]);
    expect(tie.stdout).toMatch(/ERR .*неоднозначна/u);
    const none = await py(["import jarvis", "print(bool(jarvis.find('Нет такого')))"]);
    expect(none.status).toBe(0);
    expect(none.stdout.trim()).toBe("False");
  });

  it("click(x, y, space=None) — ошибка «нужен space или frame», ничего не нажато; space='screen' — клик уходит в рубеж", async () => {
    const r = await py(["import jarvis", "try:", "    jarvis.click(10, 20, space=None)", "except jarvis.JarvisError as e:", "    print('ERR', e)"]);
    expect(r.stdout).toMatch(/ERR click: нужен space='screen'/u);
    expect(fake.calls).toEqual([]);
  });
});
