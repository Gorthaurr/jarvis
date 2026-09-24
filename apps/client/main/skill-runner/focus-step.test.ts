/**
 * Контроль-9 (побочно к focus-app-veil-swallowed): шаг `app.focus` игнорировал возвращённый `focused` —
 * `apps.focusApp` честно отвечает «фокус не перешёл», а раннер засчитывал шаг успешным и печатал следующими
 * шагами в ЧУЖОЕ окно. Реверт-проверка: убрать проверку `fr.focused` в client-actuator → кейс падает.
 */
import { describe, expect, it, vi } from "vitest";

const st = vi.hoisted(() => ({ focused: true }));
vi.mock("../actuators/apps.js", () => ({
  focusApp: async () => ({ resolved: "discord.exe", focused: st.focused }),
  launchApp: async () => ({ launched: true }),
  closeApp: async () => ({ closed: 1 }),
}));
vi.mock("../actuators/ground.js", () => ({ ground: async () => ({ handle: 1 }), invoke: async () => undefined, uiSnapshot: async () => ({ items: [] }), readContext: async () => "" }));
vi.mock("../actuators/input.js", () => ({ typeText: async () => undefined, pressKey: async () => undefined, click: async () => undefined, mouse: async () => undefined }));

import { createClientActuator } from "./client-actuator.js";

describe("шаг app.focus: «фокус не перешёл» — честный провал шага", () => {
  it("focused:false → шаг падает; focused:true → проходит", async () => {
    const a = createClientActuator();
    st.focused = false;
    await expect(a.executeStep({ action: "app.focus", params: { app: "discord" } } as never)).rejects.toThrow(/не сфокусировано/u);
    st.focused = true;
    await expect(a.executeStep({ action: "app.focus", params: { app: "discord" } } as never)).resolves.toBeUndefined();
  });
});
