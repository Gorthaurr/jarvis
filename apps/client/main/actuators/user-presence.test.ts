import { describe, expect, it } from "vitest";
import { isUserActive, ownerPresence } from "./user-presence.js";

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

/**
 * 🔴 Разбор эпизода «Дота» (2026-09-02, HIGH): снимок ПК каждые 12 секунд утверждал «Пользователь:
 * за ПК», потому что считался по СЫРОМУ системному простою — а тот сбрасывает наш собственный
 * SendInput. Джарвис кликал каждые 6-21 с, значит во время любой GUI-задачи в доверенный блок
 * промпта уходило заведомо неизвестное как факт. Модель этим объясняла свои провалы владельцу.
 */
describe("ownerPresence — присутствие ВЛАДЕЛЬЦА, а не эхо собственного ввода", () => {
  const NOW = 1_000_000;

  it("последний ввод — наш, владельцевого не видели → «не знаю», а НЕ «за ПК»", () => {
    const r = ownerPresence({ idleMs: 500, lastJarvisInputAt: NOW - 400, lastUserInputAt: 0, now: NOW });
    expect(r.state).toBe("unknown");
  });

  it("владелец недавно вводил сам → «за ПК»", () => {
    const r = ownerPresence({ idleMs: 2_000, lastJarvisInputAt: NOW - 60_000, lastUserInputAt: 0, now: NOW });
    expect(r.state).toBe("at_pc");
    expect(r.lastUserInputAt).toBe(NOW - 2_000); // отметка запомнена для следующих снимков
  });

  it("наши клики поверх старого владельцевого ввода НЕ обновляют присутствие", () => {
    // Владелец ушёл 10 минут назад; всё это время кликал Джарвис — «за ПК» писать нельзя.
    const seen = NOW - 10 * 60_000;
    const r = ownerPresence({ idleMs: 300, lastJarvisInputAt: NOW - 250, lastUserInputAt: seen, now: NOW });
    expect(r.state).toBe("away");
    expect(Math.round(r.idleMs / 60_000)).toBe(10);
    expect(r.lastUserInputAt).toBe(seen); // наш ввод отметку не двигает
  });

  it("владелец вернулся посреди GUI-задачи → снова «за ПК»", () => {
    const r = ownerPresence({ idleMs: 100, lastJarvisInputAt: NOW - 30_000, lastUserInputAt: NOW - 600_000, now: NOW });
    expect(r.state).toBe("at_pc");
  });
});
