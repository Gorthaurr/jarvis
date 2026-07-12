/**
 * §H5 (security): USER_BUSY-гейт физ.ввода для skill-runner. dispatch() глушит физическую мышь/клаву
 * ПРОАКТИВНОЙ команды при активном юзере, но skill.execute шёл в обход — createClientActuator дёргал
 * input.* напрямую. Тест проверяет, что тот же гейт присутствия применяется на уровне actuator'а навыка.
 *
 * Модули-актуаторы замоканы (реальные тянут electron/сайдкар) — здесь важна ТОЛЬКО логика гейта.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillStep } from "@jarvis/protocol";

const typeText = vi.fn(async (_t?: unknown) => undefined);
const pressKey = vi.fn(async (_c?: unknown) => undefined);
const click = vi.fn(async (_target?: unknown, _method?: unknown) => ({ clicked: true }));
const launchApp = vi.fn(async (_app?: unknown) => ({ launched: true }));

vi.mock("../actuators/input.js", () => ({
  typeText: (t: unknown) => typeText(t),
  pressKey: (c: unknown) => pressKey(c),
  click: (target: unknown, method: unknown) => click(target, method),
}));
vi.mock("../actuators/apps.js", () => ({
  launchApp: (app: unknown) => launchApp(app),
  focusApp: vi.fn(async () => undefined),
}));
vi.mock("../actuators/ground.js", () => ({
  invoke: vi.fn(async () => undefined),
  ground: vi.fn(async () => undefined),
}));

import { createClientActuator } from "./client-actuator.js";

function step(action: string, extra: Partial<SkillStep> = {}): SkillStep {
  return { action, ...extra };
}

describe("createClientActuator — USER_BUSY-гейт физ.ввода (§H5)", () => {
  beforeEach(() => {
    typeText.mockClear();
    pressKey.mockClear();
    click.mockClear();
    launchApp.mockClear();
  });

  it("ПРОАКТИВНЫЙ навык + юзер активен → физ.ввод (input.type/key/click) отклонён честной ошибкой, актуатор НЕ вызван", async () => {
    const act = createClientActuator({ isProactive: true, userActiveNow: () => true });
    for (const s of [
      step("input.type", { params: { text: "x" } }),
      step("input.key", { params: { combo: "Ctrl+S" } }),
      step("input.click", { target: { by: "role", role: "button" } as SkillStep["target"] }),
    ]) {
      await expect(act.executeStep(s)).rejects.toThrow(/USER_BUSY/);
    }
    expect(typeText).not.toHaveBeenCalled();
    expect(pressKey).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("ПРОАКТИВНЫЙ навык + юзер НЕ активен → физ.ввод исполняется", async () => {
    const act = createClientActuator({ isProactive: true, userActiveNow: () => false });
    await act.executeStep(step("input.type", { params: { text: "x" } }));
    expect(typeText).toHaveBeenCalledTimes(1);
  });

  it("ЯВНЫЙ (не проактивный) навык + юзер активен → физ.ввод НЕ гейтится (юзер сам попросил)", async () => {
    const act = createClientActuator({ isProactive: false, userActiveNow: () => true });
    await act.executeStep(step("input.type", { params: { text: "x" } }));
    expect(typeText).toHaveBeenCalledTimes(1);
  });

  it("гейт по умолчанию выключен (createClientActuator() без опций — обратная совместимость)", async () => {
    const act = createClientActuator();
    await act.executeStep(step("input.type", { params: { text: "x" } }));
    expect(typeText).toHaveBeenCalledTimes(1);
  });

  it("НЕ-физические шаги проактивного навыка при активном юзере проходят (не мышь/клава)", async () => {
    const act = createClientActuator({ isProactive: true, userActiveNow: () => true });
    await act.executeStep(step("app.launch", { params: { app: "notepad" } }));
    expect(launchApp).toHaveBeenCalledTimes(1);
  });

  // Интеграционное ревью (2-й проход): длинный литеральный input.type ломает бюджет реплея (typeText
  // неотменяем, 5с+120мс/символ; бюджет гейтит СТАРТ, не длительность). Кап 150 (~23с). Честный провал.
  it("input.type длиннее REPLAY_TYPE_MAX_CHARS → честный провал, актуатор НЕ вызван", async () => {
    const act = createClientActuator();
    const long = "х".repeat(300);
    await expect(act.executeStep(step("input.type", { params: { text: long } }))).rejects.toThrow(/не влезает в бюджет/);
    expect(typeText).not.toHaveBeenCalled();
  });

  it("input.type в пределах капа (короткая реплика) — исполняется", async () => {
    const act = createClientActuator();
    await act.executeStep(step("input.type", { params: { text: "п".repeat(120) } }));
    expect(typeText).toHaveBeenCalledTimes(1);
  });
});
