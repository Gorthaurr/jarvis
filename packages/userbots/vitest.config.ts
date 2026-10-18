import { defineConfig } from "vitest/config";
import { tempTestConfig } from "../../infra/testing/vitest-temp-config.js";

export default defineConfig({ test: tempTestConfig });
