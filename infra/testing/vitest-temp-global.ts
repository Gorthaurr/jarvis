import type { GlobalSetupContext } from "vitest/node";
import { createTestTempRun } from "./vitest-temp.js";

export default function setup({ provide }: GlobalSetupContext) {
  const run = createTestTempRun();
  provide("jarvisTestTempRoot", run.root);
  const onExit = () => {
    try { run.cleanupSync(); }
    catch (error) {
      console.error(`Unable to remove test temporary directory ${run.root}:`, error);
      process.exitCode = process.exitCode || 1;
    }
  };
  process.once("exit", onExit);
  return async () => {
    try {
      await run.cleanup();
      // Keep the exit pass: worker shutdown may flush a store and recreate a path.
    } catch {
      // Vitest 2 tears down global setup BEFORE closing its worker pool. Retry at
      // process exit after workers release Windows handles; report any final failure.
    }
  };
}
