import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createTestTempRun } from "../../testing/vitest-temp.js";

const fixture = fileURLToPath(new URL("../../testing/fixtures/verify-run.mjs", import.meta.url));

it.each(["pass", "fail", "error"])("verify %s keeps diagnostics out of Temp and cleans successful scratch files", async (mode) => {
  const work = createTestTempRun();
  try {
    const temp = join(work.root, "temp");
    const reports = join(work.root, "reports");
    mkdirSync(temp);
    mkdirSync(reports);
    const child = spawnSync(process.execPath, ["--import", "tsx", fixture, mode, reports], {
      env: { ...process.env, TMP: temp, TEMP: temp, TMPDIR: temp },
      encoding: "utf8", windowsHide: true, timeout: 15_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(mode === "pass" ? 0 : mode === "fail" ? 1 : 2);
    const { workDir } = JSON.parse(readFileSync(join(reports, "location.json"), "utf8")) as { workDir: string };
    expect(relative(join(reports, "artifacts"), workDir).startsWith("verify-")).toBe(true);
    expect(readdirSync(temp).filter((name) => name.startsWith("jarvis-verify-"))).toEqual([]);
    if (mode === "pass") {
      expect(existsSync(workDir)).toBe(false);
      expect(readdirSync(join(reports, "artifacts"))).toEqual([]);
    } else {
      expect(JSON.parse(readFileSync(join(workDir, "vitest-fixture.json"), "utf8"))).toEqual({ diagnostic: "preserve me" });
      expect(child.stderr).toContain(workDir);
    }
    if (mode !== "error") expect(JSON.parse(child.stdout).ok).toBe(mode === "pass");
  } finally { await work.cleanup(); }
});
