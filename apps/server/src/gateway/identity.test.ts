import { afterEach, describe, expect, it } from "vitest";
import { DEV_USER, isUuid, resolveAndProvision, resolveUserId } from "./identity.js";

const U = "11111111-2222-3333-4444-555555555555";

describe("resolveUserId — identity-шов (Фаза 6B мультитенант)", () => {
  afterEach(() => {
    delete process.env.JARVIS_DEV_USER_ID;
  });

  it("UUID-токен → раздел данных этого клиента (lowercased)", () => {
    expect(resolveUserId(U.toUpperCase(), {})).toBe(U);
  });

  it("дефолтный «dev-token» → seed dev-user (поведение текущей установки неизменно)", () => {
    expect(resolveUserId("dev-token", {})).toBe(DEV_USER);
  });

  it("пустой/undefined токен → dev-user", () => {
    expect(resolveUserId("", {})).toBe(DEV_USER);
    expect(resolveUserId(undefined, {})).toBe(DEV_USER);
  });

  it("JARVIS_DEV_USER_ID (UUID) переопределяет фолбэк, когда токен не UUID", () => {
    expect(resolveUserId("dev-token", { JARVIS_DEV_USER_ID: U })).toBe(U);
  });

  it("невалидный токен И невалидный env → seed (не падаем на мусоре)", () => {
    expect(resolveUserId("garbage", { JARVIS_DEV_USER_ID: "nope" })).toBe(DEV_USER);
  });

  it("isUuid строгий", () => {
    expect(isUuid(U)).toBe(true);
    expect(isUuid("dev-token")).toBe(false);
    expect(isUuid("11111111-2222-3333-4444-55555555555")).toBe(false); // короче
  });
});

describe("resolveAndProvision — async резолв + provision БЕЗ БД (граничные фолбэки)", () => {
  // В этом файле БД не сконфигурирована: query()→null, isDbReady()→false.
  // Проверяем, что provisioning не бросает и поведение совпадает с resolveUserId.
  afterEach(() => {
    delete process.env.JARVIS_DEV_USER_ID;
    delete process.env.JARVIS_AUTH_STRICT;
  });

  it("без БД: dev-token → DEV_USER (ensureUser no-op, не бросает)", async () => {
    await expect(resolveAndProvision("dev-token", {})).resolves.toBe(DEV_USER);
  });

  it("без БД: UUID-токен → его раздел (lowercased)", async () => {
    await expect(resolveAndProvision(U.toUpperCase(), {})).resolves.toBe(U);
  });

  it("без БД: пустой/мусорный токен → DEV_USER", async () => {
    await expect(resolveAndProvision("", {})).resolves.toBe(DEV_USER);
    await expect(resolveAndProvision("garbage", {})).resolves.toBe(DEV_USER);
  });

  it("без БД: JARVIS_DEV_USER_ID переопределяет для не-UUID токена", async () => {
    await expect(resolveAndProvision("dev-token", { JARVIS_DEV_USER_ID: U })).resolves.toBe(U);
  });

  it("strict + БД недоступна: НЕ брикуем — пускаем UUID как партицию (fail-open на DB-down)", async () => {
    await expect(resolveAndProvision(U, { JARVIS_AUTH_STRICT: "1" })).resolves.toBe(U);
  });
});
