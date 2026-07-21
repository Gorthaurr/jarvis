import { afterAll, describe, expect, it, vi } from "vitest";

// Изолируем data-dir ДО импорта profile.ts (DATA_DIR захватывается на импорте). vi.hoisted бежит
// раньше импортов; ставим JARVIS_DATA_DIR во временную папку, чтобы не писать в репо-data.
const TMP = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || "/tmp";
  const dir = `${base}/jarvis-profile-test-${process.pid}-${Date.now()}`;
  process.env.JARVIS_DATA_DIR = dir;
  return dir;
});

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addFact, getProfile, loadProfile, removeFactsMatching, setDisplayName, setLanguage } from "./profile.js";

const DEV_USER = "00000000-0000-0000-0000-000000000001";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("profile — партиция по userId (§6B/B3: фикс утечки имени/фактов между юзерами)", () => {
  afterAll(() => {
    try {
      rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("разные userId НЕ перетирают друг друга — ГЛАВНЫЙ фикс утечки", async () => {
    await setDisplayName(A, "Антон");
    await setDisplayName(B, "Мария");
    await addFact(A, "любит кофе");
    expect(getProfile(A).displayName).toBe("Антон");
    expect(getProfile(B).displayName).toBe("Мария"); // НЕ «Антон» — второй юзер не затёр первого
    expect(getProfile(A).facts).toEqual(["любит кофе"]);
    expect(getProfile(B).facts).toBeUndefined(); // факт A не утёк к B
  });

  it("getProfile незагруженного раздела → {} (не падает)", () => {
    expect(getProfile("99999999-9999-9999-9999-999999999999")).toEqual({});
  });

  it("персист round-trip: setX → файл на диске → loadProfile читает обратно тот же раздел", async () => {
    await setLanguage(A, "en");
    const reloaded = await loadProfile(A);
    expect(reloaded.displayName).toBe("Антон");
    expect(reloaded.language).toBe("en");
  });

  it("континьюити: раздел DEV_USER → legacy data/profile.json (существующая установка цела)", async () => {
    await setDisplayName(DEV_USER, "Старая установка");
    expect(existsSync(join(TMP, "profile.json"))).toBe(true); // legacy-путь, НЕ подкаталог
    expect(getProfile(DEV_USER).displayName).toBe("Старая установка");
  });

  it("прочие юзеры → data/profile/<userId>.json (партиция файлов)", async () => {
    await setDisplayName(B, "Мария");
    expect(existsSync(join(TMP, "profile", `${B}.json`))).toBe(true);
  });

  // Аудит контекста 2026-07-20: честное забывание курируемых фактов (раньше факты только копились FIFO).
  it("removeFactsMatching: needle ⊆ факт по словам убирает факт, exact — тоже; прочий цел", async () => {
    const C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    await addFact(C, "работает в Сбербанке аналитиком");
    await addFact(C, "любит кофе без сахара");
    // needle «работает в Сбербанке» (2 знач. токена) ⊆ факт → забыть общее убирает конкретный факт.
    const removed = await removeFactsMatching(C, ["работает в Сбербанке"]);
    expect(removed).toEqual(["работает в Сбербанке аналитиком"]);
    expect(getProfile(C).facts).toEqual(["любит кофе без сахара"]); // прочий факт цел
  });

  // РЕГРЕСС F1 (адверс-ревью): пословная сверка НЕ сносит несвязанное — ни substring («кот»⊂«скот»),
  // ни атомарный факт внутри компаундного эпизод-нидла, ни оба факта по одному общему слову.
  it("removeFactsMatching НЕ сносит несвязанные факты (substring/компаунд/одно-словный needle)", async () => {
    const E = "eeeeeeee-1111-2222-3333-444444444444";
    await addFact(E, "работает в скотоводческой компании");
    await addFact(E, "любит кофе");
    await addFact(E, "живёт в Москве");
    await addFact(E, "работает в Москве");
    // «кот» — подстрока «скотоводческой», но НЕ отдельный токен → не трогает.
    expect(await removeFactsMatching(E, ["кот"])).toEqual([]);
    // Компаундный эпизод-нидл: атомарный «любит кофе» ⊂ по словам, но направление fact⊆needle УБРАНО.
    expect(await removeFactsMatching(E, ["работаю в сбере и люблю кофе с утра"])).toEqual([]);
    // Один общий токен «Москва» (<2 знач. токенов) НЕ сносит оба Москва-факта.
    expect(await removeFactsMatching(E, ["Москва"])).toEqual([]);
    expect(getProfile(E).facts).toHaveLength(4); // всё цело
  });

  it("removeFactsMatching: короткий needle (<3) и пустой профиль — no-op", async () => {
    const D = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    await addFact(D, "любит горы");
    expect(await removeFactsMatching(D, ["ой"])).toEqual([]); // <3 симв — игнор
    expect(await removeFactsMatching("no-such-user", ["горы"])).toEqual([]); // пустой профиль
    expect(getProfile(D).facts).toEqual(["любит горы"]); // ничего не стёрто
  });
});
