/**
 * Контракт клавиш (W1-ревью р2, srv-bypass-1 / loop-bypass-1 / ext-bypass-enter-meta-alt): ОДНА таблица
 * apps/extension/test/fixtures/key-combos.json для сервера и стенда расширения (page-keys.test.mjs). Здесь — разбор
 * @jarvis/shared и §14-гейт через настоящий dispatchTool: всё, что расширение исполнит как Enter (или откажет
 * invalid_combo, а старое расширение нажало бы Enter), в мессенджере спрашивает владельца.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isCommitKeyCombo, parseKeyCombo } from "@jarvis/shared";
import { dispatchTool, type ToolContext } from "./dispatch.js";

interface Row { combo: string; key: string | null; mods?: string[]; commit: boolean }
const { cases } = JSON.parse(readFileSync(new URL("../../../../extension/test/fixtures/key-combos.json", import.meta.url), "utf8")) as { cases: Row[] };
const MODS = ["ctrl", "shift", "alt", "meta"] as const;

function ctxWith(confirm: ToolContext["confirm"]) {
  const tabAct = vi.fn(async () => ({ ok: true, sent: "x" }));
  const ext = { connected: true, tabAct, tabList: async () => ({ tabs: [] }), tabInspect: vi.fn(), tabRead: vi.fn(), openOrFocus: vi.fn(), tabClose: vi.fn(), exportCookies: vi.fn() };
  return { ctx: { session: { sendAction: vi.fn() }, userId: "u1", ext, confirm } as unknown as ToolContext, tabAct };
}

describe("key-combos.json: разбор combo — как у расширения", () => {
  it("таблица не пуста и покрывает все алиасы модификаторов и недействительные формы", () => {
    expect(cases.length).toBeGreaterThan(30);
    expect(cases.some((c) => c.key === null && c.commit)).toBe(true);
  });
  for (const row of cases) {
    it(`«${row.combo}» → ${row.key === null ? "недействителен" : `${row.key} [${row.mods?.join(",")}]`}, коммит: ${row.commit}`, () => {
      const p = parseKeyCombo(row.combo);
      if (row.key === null) expect(p).toBeNull();
      else expect(p && [p.key, MODS.filter((m) => p[m])]).toEqual([row.key, MODS.filter((m) => row.mods?.includes(m))]);
      expect(isCommitKeyCombo(row.combo)).toBe(row.commit);
    });
  }
});

describe("§14-гейт browser_act{key} в мессенджере — по той же таблице", () => {
  for (const row of cases.filter((c) => c.combo.trim())) {
    it(`combo «${row.combo}» → ${row.commit ? "вопрос владельцу" : "без вопроса"}`, async () => {
      const confirm = vi.fn(async () => ({ approved: false, outcome: "denied" as const }));
      const { ctx, tabAct } = ctxWith(confirm);
      await dispatchTool("browser_act", { url: "https://web.telegram.org/a/", intent: "key", combo: row.combo }, ctx);
      expect(confirm).toHaveBeenCalledTimes(row.commit ? 1 : 0);
      expect(tabAct).toHaveBeenCalledTimes(row.commit ? 0 : 1); // отказ владельца — расширению ничего не ушло
    });
  }
});
