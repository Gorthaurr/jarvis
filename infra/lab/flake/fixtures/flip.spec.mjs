// Три поведения: стабильный, всегда падающий и «мигающий» (падает в каждом втором прогоне: счётчик в файле из env).
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";

const counterFile = process.env.FLAKE_COUNTER_FILE;
let n = 0;
try { n = Number(readFileSync(counterFile, "utf8")) || 0; } catch { /* первый прогон */ }
writeFileSync(counterFile, String(n + 1));

it("steady", () => expect(1 + 1).toBe(2));
it("broken", () => expect(1).toBe(2));
it("flip", () => expect(n % 2).toBe(0));
it.skip("skipped-always", () => {});
