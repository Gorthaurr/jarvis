import { tempTestConfig } from "../vitest-temp-config.ts";

export default { test: { ...tempTestConfig, include: ["*.fixture.mjs"] } };
