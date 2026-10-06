/** Структура набора сценариев: не меньше 18 запускаемых, цели без подсказок про инструменты, covers резолвятся в матрицу. */
import { describe, expect, it } from "vitest";
import { collectActions, collectIntents, collectTools } from "../coverage/sources-code.js";
import { loadScenarios } from "../eval/load-scenarios.js";
import { skipReason } from "../eval/select.js";

const { scenarios } = await loadScenarios();
const runnable = scenarios.filter((s) => !s.liveOnly);
const tools = new Set(collectTools());
const actions = new Set(collectActions());
const intents = new Set(collectIntents());

describe("набор сценариев", () => {
  it("запускаемых не меньше 18, id уникальны и в kebab-case", () => {
    expect(runnable.length).toBeGreaterThanOrEqual(18);
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(scenarios.length);
    for (const s of scenarios) expect(s.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  });

  it("цели — слова владельца по-русски, без подсказок про инструменты и без сленга API", () => {
    const toolNames = [...tools].filter((t) => t.length > 3);
    for (const s of scenarios) {
      expect(s.goal, s.id).toMatch(/[а-яё]{3}/iu);
      expect(s.goal, `${s.id}: snake_case-имя в цели`).not.toMatch(/\b[a-z]+_[a-z_]+\b/u);
      expect(s.goal, `${s.id}: слова про инструменты`).not.toMatch(/инструмент|функци[юяи]|вызови|используй|\bapi\b|actioncommand|tool_/iu);
      for (const t of toolNames) expect(s.goal, `${s.id}: имя инструмента ${t}`).not.toContain(t);
    }
  });

  it("каждый cover резолвится в строку матрицы (tool:/action:/intent:)", () => {
    for (const s of scenarios) {
      for (const cover of s.covers) {
        const [kind, name] = cover.split(":");
        const known = kind === "tool" ? tools : kind === "action" ? actions : kind === "intent" ? intents : new Set<string>();
        expect(known.has(name ?? ""), `${s.id}: covers «${cover}» нет в матрице`).toBe(true);
      }
    }
  });

  it("liveOnly — с содержательной причиной; они не запускаются, остальные подходят хотя бы одному режиму", () => {
    for (const s of scenarios.filter((x) => x.liveOnly)) {
      expect(s.liveOnly!.length, s.id).toBeGreaterThan(30);
      expect(skipReason(s, { brain: "real" }), s.id).toContain("liveOnly");
    }
    for (const s of runnable) expect(skipReason(s, { brain: "real" }), s.id).toBeNull();
  });

  it("бюджеты разумны: tier0 быстрый, настоящий мозг — не короче капа задачи (240 с)", () => {
    for (const s of runnable) {
      if (s.brain === "either") expect(s.budget.maxMs, s.id).toBeLessThanOrEqual(60_000);
      else expect(s.budget.maxMs, s.id).toBeGreaterThanOrEqual(240_000);
      expect(s.budget.maxActions, s.id).toBeGreaterThan(0);
    }
  });

  it("either — только то, что закрывает tier0 (громкость); остальное требует мозг; scripted не бывает (шва нет)", () => {
    expect(runnable.filter((s) => s.brain === "either").map((s) => s.id).sort()).toEqual(["mute", "volume-louder", "volume-quieter"]);
    expect(scenarios.some((s) => s.brain === "scripted")).toBe(false);
  });

  it("сценарии по темам владельца присутствуют", () => {
    const ids = new Set(runnable.map((s) => s.id));
    for (const want of ["notepad-write", "note-file-desktop", "find-file-by-description", "move-file", "rename-file", "delete-declined", "delete-approved", "volume-quieter", "volume-louder", "mute", "clipboard-copy", "windows-monitors", "close-program", "shutdown-declined", "reminder-in-10-min", "remember-recall", "message-sent", "message-declined", "message-uncertain", "injection-in-file", "ambiguous-target", "stop-midtask"]) {
      expect(ids.has(want), want).toBe(true);
    }
  });
});
