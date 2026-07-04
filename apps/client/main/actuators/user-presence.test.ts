import { describe, expect, it } from "vitest";
import { isUserActive } from "./user-presence.js";

// § «не мешать»: пользователь активен → физический ввод откладываем; простаивает / это был сам Джарвис → ок.
describe("isUserActive — не мешать активному пользователю", () => {
  const now = 100_000;

  it("давно никто не вводил (idle ≥ порога) → НЕ активен (можно действовать)", () => {
    expect(isUserActive({ idleMs: 8000, lastJarvisInputAt: 0, now })).toBe(false);
  });

  it("пользователь только что вводил (idle мал, Джарвис давно/никогда) → активен (не мешаем)", () => {
    expect(isUserActive({ idleMs: 200, lastJarvisInputAt: 0, now })).toBe(true);
    // играет: постоянный ввод, Джарвис не инжектил
    expect(isUserActive({ idleMs: 50, lastJarvisInputAt: now - 60_000, now })).toBe(true);
  });

  it("недавний ввод — это БЫЛ САМ ДЖАРВИС (idle сброшен его SendInput) → НЕ считаем активностью юзера", () => {
    // Джарвис кликнул 200мс назад → idle≈200; lastInputAt≈now-200≈lastJarvisInputAt → не пользователь
    expect(isUserActive({ idleMs: 200, lastJarvisInputAt: now - 200, now })).toBe(false);
  });

  it("мульти-шаг Джарвиса (его клики подряд) НЕ блокируют сами себя", () => {
    // каждый следующий клик: idle мал, но последний ввод — наш недавний клик
    expect(isUserActive({ idleMs: 120, lastJarvisInputAt: now - 120, now })).toBe(false);
  });

  it("пользователь вмешался ПОЗЖЕ нашего клика (ввод свежее) → активен (уступаем)", () => {
    // Джарвис кликал 3с назад, но 100мс назад пользователь сам дёрнул мышь → idle=100
    expect(isUserActive({ idleMs: 100, lastJarvisInputAt: now - 3000, now })).toBe(true);
  });

  it("порог/толеранс настраиваются", () => {
    expect(isUserActive({ idleMs: 1500, lastJarvisInputAt: 0, now, thresholdMs: 1000 })).toBe(false); // idle>порог
    expect(isUserActive({ idleMs: 500, lastJarvisInputAt: now - 600, now, toleranceMs: 900 })).toBe(false); // в пределах нашего
  });
});
