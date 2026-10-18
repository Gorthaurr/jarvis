import { writeFileSync } from "node:fs";
import { join } from "node:path";

// An isolated source copy can be supplied by mutation checks without editing the live runner.
const { runVerification } = await import(process.env.VERIFY_RUNNER_FIXTURE_MODULE ?? "../../lab/verify.ts");

const [mode, out] = process.argv.slice(2);
const record = (ctx) => {
  writeFileSync(join(ctx.workDir, "vitest-fixture.json"), JSON.stringify({ diagnostic: "preserve me" }));
  writeFileSync(join(out, "location.json"), JSON.stringify({ workDir: ctx.workDir }));
};
const step = {
  id: "fixture", title: "isolated runner fixture", profiles: ["quick"], timeoutMs: 1000,
  gate: mode === "error" ? (ctx) => { record(ctx); throw new Error("unexpected fixture error"); } : undefined,
  inproc: async (ctx) => { record(ctx); return { status: mode }; },
};
try {
  process.exitCode = await runVerification({ profile: "quick", json: true, only: ["fixture"],
    base: "HEAD", out, list: false }, [step]);
} catch (error) {
  console.error(error);
  process.exitCode = 2;
}
