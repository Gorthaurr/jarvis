import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

declare module "vitest" {
  export interface ProvidedContext { jarvisTestTempRoot: string }
}

const retries = { recursive: true, force: true, maxRetries: 8, retryDelay: 100 };

/** Own exactly one newly-created directory; never sweep the user's Temp by prefix. */
export function createTestTempRun(parent = tmpdir()) {
  const base = realpathSync(parent);
  const root = mkdtempSync(join(base, "jarvis-vitest-"));
  const check = () => {
    if (!isAbsolute(root) || dirname(root) !== base || !basename(root).startsWith("jarvis-vitest-")) {
      throw new Error(`Refusing to clean an unowned test directory: ${root}`);
    }
    try {
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Test directory was replaced: ${root}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  return {
    root,
    async cleanup() { check(); await rm(root, retries); },
    cleanupSync() { check(); rmSync(root, retries); },
  };
}

/** Runs before each test module, including its top-level imports and child processes. */
export function isolateTestTemp(root: string): string {
  if (!root || !isAbsolute(root)) throw new Error("Missing Vitest-owned temporary directory");
  const suite = mkdtempSync(join(root, "suite-"));
  for (const key of ["TMP", "TEMP", "TMPDIR"]) process.env[key] = suite;
  // An inherited production override must never redirect a test into live data.
  process.env.JARVIS_DATA_DIR = join(suite, "data");
  mkdirSync(process.env.JARVIS_DATA_DIR);
  return suite;
}
