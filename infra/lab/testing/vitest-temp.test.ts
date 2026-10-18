import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createTestTempRun } from "../../testing/vitest-temp.js";

const fixtures = fileURLToPath(new URL("../../testing/fixtures/", import.meta.url));
const cli = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));
interface Probe {
  root: string; temp: string; artifact: string; data: string;
  child: { temp: string; artifact: string };
}

function launch(output: string, parent: string, fail: boolean, pool: string) {
  return new Promise<{ code: number | null; log: string; probes: Probe[] }>((resolve, reject) => {
    const env = { ...process.env, TMP: parent, TEMP: parent, TMPDIR: parent,
      JARVIS_DATA_DIR: join(parent, "production-sentinel"),
      TEMP_PROBE_OUTPUT: output, TEMP_PROBE_FAIL: fail ? "1" : "0" };
    const child = spawn(process.execPath, [cli, "run", "--pool", pool, "--minWorkers", "2", "--maxWorkers", "2"],
      { cwd: fixtures, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (chunk) => { log += chunk; });
    child.stderr.on("data", (chunk) => { log += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      const probes = existsSync(output) ? readdirSync(output).map((name) =>
        JSON.parse(readFileSync(join(output, name), "utf8")) as Probe) : [];
      resolve({ code, log, probes });
    });
  });
}

it.each(["forks", "threads"])("cleans passing and failing concurrent %s runs, including child-process files", async (pool) => {
  const work = createTestTempRun();
  try {
    const sentinel = join(work.root, "production-sentinel");
    mkdirSync(sentinel);
    writeFileSync(join(sentinel, "keep.txt"), "untouched");
    const results = await Promise.all([
      launch(join(work.root, "pass"), work.root, false, pool),
      launch(join(work.root, "fail"), work.root, true, pool),
    ]);
    expect(results.map((r) => r.code), results.map((r) => r.log).join("\n")).toEqual([0, 1]);
    const roots = new Set<string>();
    for (const result of results) {
      expect(result.probes, result.log).toHaveLength(2);
      expect(new Set(result.probes.map((p) => p.temp)).size).toBe(2);
      for (const probe of result.probes) {
        roots.add(probe.root);
        expect(relative(work.root, probe.root).startsWith("jarvis-vitest-")).toBe(true);
        expect(relative(probe.root, probe.temp).startsWith("suite-")).toBe(true);
        expect(probe.child.temp).toBe(probe.temp);
        expect(probe.data).not.toBe(sentinel);
        for (const path of [probe.root, probe.temp, probe.artifact, probe.data, probe.child.artifact]) {
          expect(existsSync(path), `Temporary artifact survived child exit: ${path}`).toBe(false);
        }
      }
    }
    expect(roots.size).toBe(2);
    expect(readFileSync(join(sentinel, "keep.txt"), "utf8")).toBe("untouched");
  } finally { await work.cleanup(); }
}, 60_000);

it("removes only its owned tree and does not follow a junction into sibling data", async () => {
  const parent = createTestTempRun();
  try {
    const owner = createTestTempRun(parent.root);
    const sibling = join(parent.root, "keep");
    mkdirSync(sibling);
    writeFileSync(join(sibling, "sentinel.txt"), "keep");
    symlinkSync(sibling, join(owner.root, "link"), process.platform === "win32" ? "junction" : "dir");
    await owner.cleanup();
    owner.cleanupSync(); // A repeated cleanup is harmless, including the exit fallback.
    expect(existsSync(owner.root)).toBe(false);
    expect(readFileSync(join(sibling, "sentinel.txt"), "utf8")).toBe("keep");
  } finally { await parent.cleanup(); }
});

it("repeats cleanup at process exit after a worker-like late flush recreates the directory", async () => {
  const work = createTestTempRun();
  try {
    const output = join(work.root, "late-write.json");
    execFileSync(process.execPath, ["--import", "tsx", join(fixtures, "late-write.mjs")], {
      env: { ...process.env, TMP: work.root, TEMP: work.root, TMPDIR: work.root, TEMP_PROBE_OUTPUT: output },
      windowsHide: true, encoding: "utf8",
    });
    const { root } = JSON.parse(readFileSync(output, "utf8")) as { root: string };
    expect(existsSync(root), "Late worker flush survived process exit").toBe(false);
  } finally { await work.cleanup(); }
});
