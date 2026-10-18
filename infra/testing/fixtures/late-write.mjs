import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import setup from "../vitest-temp-global.ts";

let root;
const teardown = setup({ provide(_key, value) { root = value; } });
await teardown();
// Reproduce a worker's shutdown flush AFTER the first cleanup succeeded.
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "late-flush.txt"), "late");
writeFileSync(process.env.TEMP_PROBE_OUTPUT, JSON.stringify({ root }));
