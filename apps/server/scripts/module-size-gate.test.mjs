/**
 * W2 (пакет 0, P0-f): правила гейта размеров модулей (закон CLAUDE.md «модули < 150 строк, раздутые не растут»).
 * Реверт-проверка: ослабь любое правило judge() — строка таблицы упадёт; сломай проверку входа — упадёт
 * «запуск как скрипт» (гейт молча выходит с кодом 0).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLOW_GROWTH, LIMIT, isGatedModule, judge } from "./module-size-gate.mjs";

const none = new Set();

describe("judge", () => {
  it.each([
    ["новый ≤ 150 — ок", null, 150, none, false],
    ["новый 151 — нарушение", null, 151, none, true],
    ["был ≤ 150, стал ≤ 150 — ок", 100, 150, none, false],
    ["был ≤ 150, вырос за 150 — нарушение", 140, 151, none, true],
    ["раздутый не вырос — ок", 400, 400, none, false],
    ["раздутый уменьшился — ок", 400, 350, none, false],
    ["раздутый +1 без врезки — нарушение", 400, 401, none, true],
    ["раздутый +5 с врезкой --allow — ок", 400, 400 + ALLOW_GROWTH, new Set(["a.ts"]), false],
    ["раздутый +6 даже с врезкой — нарушение", 400, 401 + ALLOW_GROWTH, new Set(["a.ts"]), true],
    ["удалён — ок", 400, null, none, false],
  ])("%s", (_name, base, head, allowed, bad) => {
    expect(Boolean(judge("a.ts", base, head, allowed))).toBe(bad);
  });

  it("порог — 150 строк", () => {
    expect(LIMIT).toBe(150);
  });
});

describe("isGatedModule", () => {
  it("судим только не-тестовые .ts (без деклараций и test-support)", () => {
    expect(isGatedModule("apps/server/src/brain/tools/dispatch.ts")).toBe(true);
    expect(isGatedModule("apps/server/src/brain/tools/dispatch.test.ts")).toBe(false);
    expect(isGatedModule("apps/client/main/test-support/fake-sidecar.ts")).toBe(false);
    expect(isGatedModule("packages/x/src/types.d.ts")).toBe(false);
    expect(isGatedModule("apps/server/scripts/module-size-gate.mjs")).toBe(false);
  });
});

describe("запуск как скрипт (node …/module-size-gate.mjs)", () => {
  // Вход сверялся строкой `file://${argv[1]}`: на Windows `file:///C:/…` против `C:\…` не совпадал никогда —
  // гейт молча выходил с кодом 0 на ЛЮБОМ изменении (27.09). Гоняем настоящий процесс на временном репо.
  const SCRIPT = fileURLToPath(new URL("./module-size-gate.mjs", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const ident = ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t"];
  const lines = (n) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};\n`).join("");
  let repo = "";
  const git = (...args) => execFileSync("git", [...ident, ...args], { cwd: repo, env, stdio: "ignore" });
  const gate = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, env, encoding: "utf8" });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "size-gate-"));
    git("init", "-q");
    writeFileSync(join(repo, "base.ts"), lines(3));
    git("add", ".");
    git("commit", "-qm", "base");
  });
  afterAll(() => {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // временный каталог: занятый .git на Windows не должен ронять набор
    }
  });

  it("без BASE — код 2 и usage", () => {
    const r = gate();
    expect(r.stderr).toContain("usage: module-size-gate.mjs <BASE>");
    expect(r.status).toBe(2);
  });

  it("новый модуль 150 строк — код 0 и итог «ок»", () => {
    writeFileSync(join(repo, "small.ts"), lines(LIMIT));
    const r = gate("HEAD");
    expect(r.stdout).toContain("гейт размеров: ок (1 модулей)");
    expect(r.status).toBe(0);
  });

  it("новый модуль 151 строка — код 1 и текст нарушения", () => {
    writeFileSync(join(repo, "big.ts"), lines(LIMIT + 1));
    const r = gate("HEAD");
    expect(r.stdout).toContain(`big.ts: новый модуль ${LIMIT + 1} строк > ${LIMIT}`);
    expect(r.stdout).toContain("НАРУШЕНИЙ: 1");
    expect(r.status).toBe(1);
  });
});
