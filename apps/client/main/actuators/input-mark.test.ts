/**
 * ПРОВОДКА реестра собственного ввода (адверс-ревью 2026-09-02, HIGH).
 *
 * Корень: отметка «это наш ввод» ставилась ВРУЧНУЮ в switch'е `actuators/index.ts`, поэтому мимо неё
 * шли пути, которые дёргают input.* напрямую — прежде всего БЫСТРЫЙ РЕПЛЕЙ навыка (skill-runner) с
 * бюджетом 80 секунд. Итог, воспроизведённый ревьюером: владельца нет в комнате, идёт реплей — а
 * снимок ПК две минуты подряд пишет в промпт «Пользователь: за ПК», и `userActiveNow()` может
 * зарубить наш же проактивный реплей как USER_BUSY.
 *
 * Тест бьёт в МЕСТО ИНЖЕКЦИИ: помечается сам input.ts → любой вызывающий (skill-runner, dispatch,
 * будущий код) получает отметку без правки списка call-site'ов. Мутант «убрать noteJarvisInput из
 * input.ts» роняет эти кейсы.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./sidecar-client.js", () => ({
  sidecar: () => ({ ready: true, request: async () => ({ ok: true }) }),
}));
vi.mock("./screen.js", () => ({ getLastCaptureMapping: () => undefined }));

const { _resetJarvisInputForTest, lastJarvisInput } = await import("./input-mark.js");
const input = await import("./input.js");

beforeEach(() => _resetJarvisInputForTest());

describe("собственный ввод помечается ТАМ, ГДЕ ИНЖЕКТИТСЯ", () => {
  it("клик по координатам", async () => {
    expect(lastJarvisInput()).toBe(0);
    await input.click({ by: "coords", x: 10, y: 20, space: "screen" }, "physical").catch(() => undefined);
    expect(lastJarvisInput()).toBeGreaterThan(0);
  });

  it("печать текста", async () => {
    await input.typeText("привет").catch(() => undefined);
    expect(lastJarvisInput()).toBeGreaterThan(0);
  });

  it("нажатие клавиши", async () => {
    await input.pressKey("enter").catch(() => undefined);
    expect(lastJarvisInput()).toBeGreaterThan(0);
  });

  it("мышь (drag/wheel)", async () => {
    await input.mouse({ op: "wheel", dy: -3 } as never).catch(() => undefined);
    expect(lastJarvisInput()).toBeGreaterThan(0);
  });

  it("ЗАБЛОКИРОВАННОЕ комбо ввод НЕ инжектит — но отметка уже стоит (консервативно: лучше лишний раз счесть ввод нашим, чем приписать его владельцу)", async () => {
    await input.pressKey("alt+f4").catch(() => undefined);
    expect(lastJarvisInput()).toBeGreaterThan(0);
  });
});
