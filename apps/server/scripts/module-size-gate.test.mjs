/**
 * W2 (пакет 0, P0-f): правила гейта размеров модулей (закон CLAUDE.md «модули < 150 строк, раздутые не растут»).
 * Реверт-проверка: ослабь любое правило judge() — строка таблицы упадёт.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOW_GROWTH, LIMIT, isGatedModule, judge } from "./module-size-gate.mjs";

const GATE = fileURLToPath(new URL("./module-size-gate.mjs", import.meta.url));

/** Запуск без BASE: живой гейт обязан ответить usage и кодом 2 (молчащий гард — 0 и пустота). */
function expectUsageExit(script) {
  const r = spawnSync(process.execPath, [script], { cwd: dirname(GATE), encoding: "utf8", windowsHide: true, timeout: 20_000 });
  expect(r.error).toBeUndefined();
  expect(r.stderr).toMatch(/usage: module-size-gate\.mjs <BASE>/u);
  expect(r.stdout).toBe("");
  expect(r.status).toBe(2);
}

describe("запуск как скрипт", () => {
  // 27.09: гард «я — точка входа» сравнивал `file://${argv[1]}` с import.meta.url; на Windows argv[1] —
  // `C:\…`, а url — `file:///C:/…` → main() не звался, гейт молча отдавал 0 на любом BASE.
  it("гейт реально запускается как скрипт (Windows: argv[1] vs import.meta.url) — без BASE → usage и код 2", () => {
    expectUsageExit(GATE);
  });

  // import.meta.url точки входа Node строит из realpath, argv[1] — нет: через ссылку на папку гард без realpath молчит.
  it("через junction/симлинк на папку скриптов — тоже usage и код 2", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gate-link-"));
    const link = join(tmp, "scripts");
    symlinkSync(dirname(GATE), link, "junction");
    try {
      expectUsageExit(join(link, basename(GATE)));
    } finally {
      unlinkSync(link); // снимает только ссылку (не идёт внутрь), без рекурсии
      rmdirSync(tmp);
    }
  });
});

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
