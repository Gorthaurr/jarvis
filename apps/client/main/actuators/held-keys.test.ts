/**
 * Контроль-10 (presskey-catch-clears-held): провал RPC откатывает ТОЛЬКО СВОЙ вклад в реестр удержаний.
 * Прежний catch стирал и клавиши, удержанные ПРЕДЫДУЩИМИ успешными вызовами: провалившийся повторный `down` Alt
 * «забывал» реально зажатый Alt, и следующий `press F4` собирал Alt+F4 мимо блок-листа (инцидент «закрыл сам себя»).
 * Реверт-проверка: вернуть безусловное удаление ключей в catch → кейс падает.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const st = vi.hoisted(() => ({ fail: false }));
vi.mock("./sidecar-client.js", () => ({
  sidecar: () => ({
    ready: true,
    request: async () => {
      if (st.fail) throw new Error("сайдкар не ответил");
      return {};
    },
  }),
}));
vi.mock("./screen.js", () => ({ getLastCaptureMapping: () => null }));
vi.mock("electron", () => ({ powerMonitor: { getSystemIdleTime: () => 999 } }));

import { pressKey, resetHeldKeys } from "./input.js";

describe("реестр удержанных клавиш переживает провал RPC", () => {
  afterEach(() => {
    resetHeldKeys();
    st.fail = false;
  });

  it("успешный Alt(down) + провалившийся повторный Alt(down) → F4 всё ещё запрещён", async () => {
    await pressKey("Alt", "down");
    st.fail = true;
    await expect(pressKey("Alt", "down")).rejects.toThrow(/сайдкар не ответил/u);
    st.fail = false;
    await expect(pressKey("F4", "press")).rejects.toThrow(/запрещена/u);
  });

  it("провал ПЕРВОГО down не оставляет фантомного удержания", async () => {
    st.fail = true;
    await expect(pressKey("Alt", "down")).rejects.toThrow(/сайдкар не ответил/u);
    st.fail = false;
    await expect(pressKey("F4", "press")).resolves.toBeUndefined();
  });
});
