import { afterAll, describe, expect, it, vi } from "vitest";

// Изолируем data-dir ДО импорта profile.ts (DATA_DIR захватывается на импорте). vi.hoisted бежит
// раньше импортов; ставим JARVIS_DATA_DIR во временную папку, чтобы не писать в репо-data.
const TMP = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || "/tmp";
  const dir = `${base}/jarvis-profile-test-${process.pid}-${Date.now()}`;
  process.env.JARVIS_DATA_DIR = dir;
  return dir;
});

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addFact, getProfile, loadProfile, readEvictedFacts, removeFactsMatching, setDisplayName, setLanguage } from "./profile.js";

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

  // Аудит 2026-07-28: вытеснение по капу НЕ бесследно — старейший факт уходит в durable-архив
  // (evicted-<user>.jsonl), кап настраиваем через JARVIS_PROFILE_FACTS_MAX (кламп снизу 10).
  it("кап фактов: старейший вытесняется В АРХИВ, не бесследно; кап управляем env", async () => {
    const F = "ffffffff-1111-2222-3333-555555555555";
    const saved = process.env.JARVIS_PROFILE_FACTS_MAX;
    process.env.JARVIS_PROFILE_FACTS_MAX = "3"; // клампится до 10 (минимум)
    try {
      for (let i = 1; i <= 11; i++) await addFact(F, `факт номер ${i}`);
      const facts = getProfile(F).facts ?? [];
      expect(facts).toHaveLength(10); // кламп снизу: меньше 10 кап не бывает
      expect(facts[0]).toBe("факт номер 2"); // старейший («факт номер 1») вытеснен
      const archive = join(TMP, "profile", `evicted-${F}.jsonl`);
      expect(existsSync(archive)).toBe(true); // …но НЕ бесследно — заархивирован
      const lines = readFileSync(archive, "utf8").trim().split("\n");
      expect(JSON.parse(lines[0]!).fact).toBe("факт номер 1");
    } finally {
      if (saved === undefined) delete process.env.JARVIS_PROFILE_FACTS_MAX;
      else process.env.JARVIS_PROFILE_FACTS_MAX = saved;
    }
  });
});

// Волна E (вкладка «Память»): архив вытесненных — витрина честности «ничего не пропало молча».
describe("readEvictedFacts — архив вытесненных для вкладки «Память»", () => {
  const C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

  it("архива нет (ничего не вытеснялось) → пустой список, не падение", async () => {
    await loadProfile(C);
    expect(await readEvictedFacts(C)).toEqual([]);
  });

  it("вытесненные капом факты читаются, новые первыми, с временем", async () => {
    const saved = process.env.JARVIS_PROFILE_FACTS_MAX;
    process.env.JARVIS_PROFILE_FACTS_MAX = "10"; // кламп-минимум
    try {
      await loadProfile(C);
      for (let i = 1; i <= 13; i += 1) await addFact(C, `факт номер ${i}`);
      const evicted = await readEvictedFacts(C);
      // 13 добавленных при капе 10 → три старейших уехали в архив.
      expect(evicted).toHaveLength(3);
      expect(evicted[0]?.fact).toBe("факт номер 3"); // новые первыми (последний вытесненный — сверху)
      expect(evicted.at(-1)?.fact).toBe("факт номер 1");
      expect(typeof evicted[0]?.ts).toBe("number");
      // И они РЕАЛЬНО ушли из активного профиля (иначе витрина показывала бы дубли).
      expect(getProfile(C).facts).not.toContain("факт номер 1");
      // limit уважается.
      expect(await readEvictedFacts(C, 2)).toHaveLength(2);
    } finally {
      if (saved === undefined) delete process.env.JARVIS_PROFILE_FACTS_MAX;
      else process.env.JARVIS_PROFILE_FACTS_MAX = saved;
    }
  });
});
