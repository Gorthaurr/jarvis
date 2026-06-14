import { describe, expect, it } from "vitest";
import type { SkillStep } from "@jarvis/protocol";
import {
  applySkillRevision,
  canPromoteSkillVersion,
  shouldRollbackSkillVersion,
} from "./index.js";

describe("границы автоправки навыков (§8)", () => {
  it("guard-шаг заморожен: не заменяется предложенной ревизией (правило 1)", () => {
    const current: SkillStep[] = [
      { action: "ui.invoke", target: { by: "role", role: "button" } },
      { action: "message.send" }, // guard
    ];
    const proposed: SkillStep[] = [
      { action: "ui.invoke", target: { by: "role", role: "link" } }, // правка не-guard
      { action: "input.type", params: { text: "взлом" } }, // попытка подменить guard
    ];
    const { steps, blockedIndices } = applySkillRevision(current, proposed);
    expect(steps[0]).toEqual(proposed[0]); // не-guard заменён
    expect(steps[1]).toEqual(current[1]); // guard сохранён
    expect(blockedIndices).toEqual([1]);
  });

  it("добавление не-guard шага в конец допускается", () => {
    const current: SkillStep[] = [{ action: "app.focus", params: { app: "X" } }];
    const proposed: SkillStep[] = [
      { action: "app.focus", params: { app: "X" } },
      { action: "ui.invoke", target: { by: "role", role: "button" } },
    ];
    const { steps } = applySkillRevision(current, proposed);
    expect(steps).toHaveLength(2);
  });

  it("промоут версии только после успешного прогона и без сбоев (правило 3)", () => {
    expect(canPromoteSkillVersion({ hadSuccessfulRun: true, newVersionFailCount: 0 })).toBe(true);
    expect(canPromoteSkillVersion({ hadSuccessfulRun: false, newVersionFailCount: 0 })).toBe(false);
    expect(canPromoteSkillVersion({ hadSuccessfulRun: true, newVersionFailCount: 5 })).toBe(false);
  });

  it("откат по накопленным сбоям (правило 4)", () => {
    expect(shouldRollbackSkillVersion(0)).toBe(false);
    expect(shouldRollbackSkillVersion(2)).toBe(true);
  });
});
