import { describe, expect, it } from "vitest";
import { DEFAULT_MODE_ID, getMode, listModes, matchModeCommand } from "./modes.js";

describe("режимы-маски Джарвиса (§11)", () => {
  it("getMode: неизвестный/пустой id → базовый дворецкий", () => {
    expect(getMode(undefined).id).toBe(DEFAULT_MODE_ID);
    expect(getMode("нет_такого").id).toBe(DEFAULT_MODE_ID);
    expect(getMode("bold").id).toBe("bold");
  });

  it("базовый режим без оверлея (тон задаёт persona.md), остальные — с оверлеем", () => {
    expect(getMode("butler").overlay).toBe("");
    expect(getMode("bold").overlay.length).toBeGreaterThan(0);
    expect(getMode("storyteller").overlay.length).toBeGreaterThan(0);
  });

  it("у тон-режимов есть подстройка голоса (style/stability/speed)", () => {
    expect(getMode("bold").voice).toBeDefined();
    expect(listModes().length).toBeGreaterThanOrEqual(4);
  });

  it("matchModeCommand распознаёт явную смену режима", () => {
    expect(matchModeCommand("Джарвис, будь дерзким")).toBe("bold");
    expect(matchModeCommand("включи режим рассказчика")).toBe("storyteller");
    expect(matchModeCommand("будь смешным")).toBe("comedian");
    expect(matchModeCommand("будь собой")).toBe("butler");
    expect(matchModeCommand("вернись в обычный режим")).toBe("butler");
  });

  it("обычные команды НЕ принимаются за смену режима (консервативно)", () => {
    expect(matchModeCommand("открой телеграм")).toBeNull();
    expect(matchModeCommand("расскажи погоду на завтра")).toBeNull(); // «расскажи» без маркера режима
    expect(matchModeCommand("сколько сейчас времени")).toBeNull();
    expect(matchModeCommand("напиши кате привет")).toBeNull();
  });
});
