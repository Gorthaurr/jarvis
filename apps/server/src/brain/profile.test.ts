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
import { addFact, getProfile, loadProfile, setDisplayName, setLanguage } from "./profile.js";

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
});
