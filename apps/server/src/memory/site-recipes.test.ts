import { describe, expect, it } from "vitest";
import { SiteRecipeStore, normalizeHost, seedSiteRecipes } from "./site-recipes.js";

describe("site-recipes: хранилище рецептов сайтов", () => {
  it("normalizeHost: схема/www/путь срезаются, голый host принимается", () => {
    expect(normalizeHost("https://www.YouTube.com/watch?v=1")).toBe("youtube.com");
    expect(normalizeHost("music.yandex.ru")).toBe("music.yandex.ru");
    expect(normalizeHost("WWW.VK.com")).toBe("vk.com");
    expect(normalizeHost("")).toBe("");
  });

  it("upsert + recall по точному host (не по семантике)", () => {
    const s = new SiteRecipeStore(() => 1000);
    s.upsert("shop.example", "поле поиска сверху; кнопка «Купить» справа", "learned");
    expect(s.recall("shop.example")?.hint).toMatch(/Купить/);
    expect(s.recall("https://www.shop.example/cart")?.hint).toMatch(/Купить/); // нормализация на recall
    expect(s.recall("other.example")).toBeNull();
  });

  it("seed НЕ перетирается learned'ом (курируемое знание главнее)", () => {
    const s = new SiteRecipeStore(() => 1000);
    seedSiteRecipes(s);
    const seeded = s.recall("music.yandex.ru");
    expect(seeded?.source).toBe("seed");
    s.upsert("music.yandex.ru", "мусор от авто-обучения", "learned");
    expect(s.recall("music.yandex.ru")?.hint).toBe(seeded?.hint); // seed сохранён
    expect(s.recall("music.yandex.ru")?.source).toBe("seed");
  });

  it("demote до порога → recall замолкает (учится на ошибках); reinforce восстанавливает", () => {
    const s = new SiteRecipeStore(() => 1000);
    s.upsert("flaky.example", "приём X", "learned");
    s.demote("flaky.example");
    s.demote("flaky.example");
    expect(s.recall("flaky.example")).not.toBeNull(); // 2 провала — ещё живой
    s.demote("flaky.example"); // 3-й провал (порог FAIL_SUPPRESS=3)
    expect(s.recall("flaky.example")).toBeNull(); // подавлен
    s.reinforce("flaky.example"); // успех сбросил счётчик
    expect(s.recall("flaky.example")).not.toBeNull();
  });

  it("restore/toJSON round-trip сохраняет source и failCount", () => {
    const s = new SiteRecipeStore(() => 1000);
    s.upsert("a.example", "hint A", "learned");
    s.demote("a.example");
    const rows = s.toJSON();
    const s2 = new SiteRecipeStore(() => 2000);
    s2.restore(rows);
    expect(s2.recall("a.example")?.hint).toBe("hint A");
    const raw = s2.toJSON().find((r) => r.host === "a.example");
    expect(raw?.failCount).toBe(1);
    expect(raw?.source).toBe("learned");
  });
});
