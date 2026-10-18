import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, inject, test } from "vitest";

export function probe(name) {
  // Deliberately no fixture cleanup: the run owner must remove top-level leaks too.
  const artifact = mkdtempSync(join(tmpdir(), "fixture-leak-"));
  writeFileSync(join(artifact, "data.txt"), name);
  test("temporary paths are isolated before module evaluation and inherited by children", () => {
    const child = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { mkdtempSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      console.log(JSON.stringify({ temp: tmpdir(), artifact: mkdtempSync(join(tmpdir(), 'child-')) }));
    `], { encoding: "utf8" }));
    const result = { root: inject("jarvisTestTempRoot"), temp: tmpdir(), artifact,
      data: process.env.JARVIS_DATA_DIR, child };
    mkdirSync(process.env.TEMP_PROBE_OUTPUT, { recursive: true });
    writeFileSync(join(process.env.TEMP_PROBE_OUTPUT, `${name}.json`), JSON.stringify(result));
    expect([process.env.TMP, process.env.TEMP, process.env.TMPDIR]).toEqual(Array(3).fill(tmpdir()));
    expect(child.temp).toBe(tmpdir());
    expect(result.data).toBe(join(tmpdir(), "data"));
    expect(process.env.TEMP_PROBE_FAIL, "deliberate failure after creating temporary artifacts").not.toBe("1");
  });
}
