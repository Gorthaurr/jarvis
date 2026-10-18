import { fileURLToPath } from "node:url";

/** Shared by every Vitest entry point, including direct `vitest run` commands. */
export const tempTestConfig = {
  globalSetup: [fileURLToPath(new URL("./vitest-temp-global.ts", import.meta.url))],
  setupFiles: [fileURLToPath(new URL("./vitest-temp-setup.ts", import.meta.url))],
  sequence: { setupFiles: "list" as const },
};
