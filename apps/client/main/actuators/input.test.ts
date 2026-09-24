/**
 * Гард опасных комбо (§6 «не навреди»): после инцидента «закрой Доту → Джарвис закрыл сам себя»
 * (Alt+F4 в эмуляции ввода) опасные глобальные комбо НЕ шлются. Нормализация регистра/порядка/алиасов.
 */
import { afterEach, describe, expect, it } from "vitest";
import { click, isBlockedCombo, mouse, normalizeCombo, pressKey, resetHeldKeys, seedHeldKeys, typeText } from "./input.js";
import { selectionStore } from "../selection/store.js";

describe("input: §режим выделения — гейт стоит в ТОЧКЕ ИНЖЕКЦИИ (реплей навыка/SDK не обходят)", () => {
  afterEach(() => selectionStore.setDrawing(false));

  it("пока открыта вуаль рисования, клавиша и печать отвергаются честной причиной ДО сайдкара", async () => {
    selectionStore.setDrawing(true);
    await expect(pressKey("Ctrl+S")).rejects.toThrow(/оверлей/u);
    await expect(typeText("привет")).rejects.toThrow(/оверлей/u);
  });

  it("явно ФИЗИЧЕСКИЙ клик (coords / physical) и мышь отвергаются ДО сайдкара — этим путём идут реплей навыка и SDK-мост (контроль-3)", async () => {
    selectionStore.setDrawing(true);
    await expect(click({ by: "coords", x: 10, y: 10 })).rejects.toThrow(/оверлей/u);
    await expect(click({ by: "handle", handle: "7" }, "physical")).rejects.toThrow(/оверлей/u);
    await expect(mouse({ op: "move", x: 1, y: 1 })).rejects.toThrow(/оверлей/u);
  });

  it("контроль-4: правый / двойной клик по handle под вуалью — тоже физический, гейт ДО сайдкара", async () => {
    selectionStore.setDrawing(true);
    await expect(click({ by: "handle", handle: "7" }, "silent", true, { button: "right" })).rejects.toThrow(/оверлей/u);
    await expect(click({ by: "handle", handle: "7" }, "silent", true, { count: 2 })).rejects.toThrow(/оверлей/u);
  });

  it("контроль-4: ПОЛИТИКА выше СОСТОЯНИЯ — Alt+F4 под вуалью получает постоянный запрет, а не «дождись и повтори»; up отпускает клавишу и под вуалью", async () => {
    selectionStore.setDrawing(true);
    await expect(pressKey("Alt+F4")).rejects.toThrow(/запрещена/);
    await expect(pressKey("W", "up")).rejects.toThrow(/сайдкар не запущен/); // гейт вуали пропустил — дошли до сайдкара
  });

  it("контроль-9 (mouse-up-terminates-owner-drawing): под вуалью НЕ проходит ни одна операция мыши, включая отпускание", async () => {
    selectionStore.setDrawing(true);
    // Послабление контроля-8 отменено: `mouseup` — ГЛАВНОЕ событие окна рисования, оно завершило бы выделение
    // владельца в точке курсора. Залипшую кнопку снимает releaseHeldPointer при закрытии вуали.
    await expect(mouse({ op: "up", button: "left" })).rejects.toThrow(/оверлей/u);
    await expect(mouse({ op: "down", button: "left" })).rejects.toThrow(/оверлей/u);
  });

  it("без вуали те же вызовы доходят до сайдкара — гейт не глушит ввод вообще", async () => {
    await expect(click({ by: "coords", x: 10, y: 10 })).rejects.toThrow(/сайдкар не запущен/);
    await expect(mouse({ op: "move", x: 1, y: 1 })).rejects.toThrow(/сайдкар не запущен/);
  });
});

describe("input: гард опасных комбо (§6)", () => {
  it("Alt+F4 заблокирован в любом регистре/порядке/алиасе", () => {
    expect(isBlockedCombo("Alt+F4")).toBe(true);
    expect(isBlockedCombo("alt+f4")).toBe(true);
    expect(isBlockedCombo("F4+Alt")).toBe(true);
    expect(isBlockedCombo(" ALT + F4 ")).toBe(true);
  });

  it("системные/блокирующие комбо заблокированы (Win+L/R/D/M, Ctrl+Alt+Del, Win+Tab)", () => {
    for (const c of ["Win+L", "Win+R", "Win+D", "Win+M", "Win+Tab", "Ctrl+Alt+Delete", "Ctrl+Alt+Del", "Meta+L", "Super+R"]) {
      expect(isBlockedCombo(c)).toBe(true);
    }
  });

  it("обычные рабочие комбо РАЗРЕШЕНЫ (печать/навигация/игры)", () => {
    for (const c of ["Ctrl+S", "Ctrl+C", "Ctrl+V", "ArrowRight", "Space", "W", "Enter", "Tab", "Ctrl+Shift+T", "F5"]) {
      expect(isBlockedCombo(c)).toBe(false);
    }
  });

  it("normalizeCombo: алиасы win/del/control, регистр и порядок", () => {
    expect(normalizeCombo("Meta+L")).toBe(normalizeCombo("Win+L"));
    expect(normalizeCombo("Ctrl+Alt+Del")).toBe(normalizeCombo("Control+Alt+Delete"));
    expect(normalizeCombo("F4+Alt")).toBe(normalizeCombo("Alt+F4"));
  });
});

describe("input: H4 опасное комбо собрано удержанием (down/up между вызовами)", () => {
  afterEach(() => resetHeldKeys());

  it("Alt(down)+F4(down) → блок (сборка Alt+F4 по частям, между вызовами)", async () => {
    // Эмулируем успешный первый вызов «Alt» (mode:down) — модификатор физически удержан.
    seedHeldKeys("Alt");
    // Второй вызов «F4» (mode:down) сам по себе НЕ в блок-листе, но с удержанным Alt даёт Alt+F4 →
    // гард обязан заблокировать ДО обращения к сайдкару (BlockedKeyError, а не NotImplementedError).
    await expect(pressKey("F4", "down")).rejects.toThrow(/запрещена/);
  });

  it("одиночный F4(down) без удержания РАЗРЕШЁН гардом (падает лишь на отсутствии сайдкара)", async () => {
    // Без удержанного Alt комбинация безопасна — гард пропускает, ошибка приходит уже из ensure().
    await expect(pressKey("F4", "down")).rejects.toThrow(/сайдкар не запущен/);
  });

  it("после снятия удержания Alt комбинация F4(down) снова безопасна", async () => {
    // С удержанным Alt — блок; после снятия удержания (отпустили Alt) — гард пропускает.
    seedHeldKeys("Alt");
    await expect(pressKey("F4", "down")).rejects.toThrow(/запрещена/);
    resetHeldKeys(); // эмуляция успешного Alt(up): модификатор больше не удерживается
    await expect(pressKey("F4", "down")).rejects.toThrow(/сайдкар не запущен/);
  });

  it("аудит [10]: Alt(hold) + F4(PRESS) → блок (гард работал только для down, press обходил)", async () => {
    seedHeldKeys("Alt");
    // press F4 при удержанном Alt синтезирует Alt+F4 → обязан блокироваться ДО сайдкара.
    await expect(pressKey("F4", "press")).rejects.toThrow(/запрещена/);
    await expect(pressKey("F4")).rejects.toThrow(/запрещена/); // undefined mode = press
  });

  it("аудит [10]: блок НЕ десинкает учёт — Alt остаётся зажат, повторный заход снова блокируется", async () => {
    seedHeldKeys("Alt");
    await expect(pressKey("F4", "press")).rejects.toThrow(/запрещена/);
    // Прежде heldKeys.clear() на блоке/press «забывал» Alt → следующий F4 собирал effective=[f4] мимо
    // гарда. Теперь Alt всё ещё удержан → второй заход опять блокируется (не проваливается в сайдкар).
    await expect(pressKey("F4", "down")).rejects.toThrow(/запрещена/);
    await expect(pressKey("F4", "press")).rejects.toThrow(/запрещена/);
  });

  it("аудит [10]: press безопасной клавиши при удержанном Ctrl НЕ блокируется (гард только на опасные)", async () => {
    seedHeldKeys("Ctrl");
    // Ctrl+S не в блок-листе → гард пропускает, ошибка приходит уже из ensure() (нет сайдкара).
    await expect(pressKey("S", "press")).rejects.toThrow(/сайдкар не запущен/);
  });
});
