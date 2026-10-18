import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempRun } from "../../testing/vitest-temp.js";

it.runIf(process.platform === "win32")("retries deletion while a real Windows exclusive handle is closing", async () => {
  const run = createTestTempRun();
  const file = join(run.root, "locked.txt");
  writeFileSync(file, "temporary");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$f=[IO.File]::Open($env:TEMP_PROBE_LOCK,'Open','ReadWrite','None');" +
    "[Console]::WriteLine('ready'); Start-Sleep -Milliseconds 400; $f.Dispose()"], {
    env: { ...process.env, TEMP_PROBE_LOCK: file }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Lock holder exited ${code}`)));
  });
  try {
    await Promise.race([
      new Promise<void>((resolve) => child.stdout.once("data", () => resolve())),
      closed.then(() => { throw new Error("Lock holder exited before readiness"); }),
    ]);
    await run.cleanup();
    await closed;
    expect(existsSync(run.root)).toBe(false);
  } finally {
    await closed;
    await run.cleanup();
  }
}, 15_000);
