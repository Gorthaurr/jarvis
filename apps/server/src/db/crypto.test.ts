import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetMasterKeyForTests, decryptSecret, encryptSecret, hasCredentialCrypto } from "./crypto.js";

describe("crypto — AES-256-GCM шифрование секретов (§6B/B4)", () => {
  beforeEach(() => {
    process.env.CREDENTIALS_MASTER_KEY = "a".repeat(64); // фикс. ключ (hex-64) — детерминизм
    __resetMasterKeyForTests();
  });
  afterEach(() => {
    delete process.env.CREDENTIALS_MASTER_KEY;
    __resetMasterKeyForTests();
  });

  it("round-trip encrypt→decrypt", () => {
    const blob = encryptSecret("sk-ant-секрет-123");
    expect(blob).toBeInstanceOf(Buffer);
    expect(blob!.length).toBeGreaterThan(28); // IV(12)+tag(16)+ct
    expect(decryptSecret(blob!)).toBe("sk-ant-секрет-123");
  });

  it("случайный IV: два шифрования одного текста → РАЗНЫЕ блобы", () => {
    expect(encryptSecret("x")!.equals(encryptSecret("x")!)).toBe(false);
  });

  it("неверный мастер-ключ → null (GCM auth-fail, не мусор)", () => {
    const blob = encryptSecret("секрет")!;
    process.env.CREDENTIALS_MASTER_KEY = "b".repeat(64);
    __resetMasterKeyForTests();
    expect(decryptSecret(blob)).toBeNull();
  });

  it("подмена байта блоба → null (целостность)", () => {
    const blob = encryptSecret("секрет")!;
    const last = blob.length - 1;
    blob[last] = (blob[last] ?? 0) ^ 0xff;
    expect(decryptSecret(blob)).toBeNull();
  });

  it("passphrase произвольной длины → 32 байта (sha256), round-trip ок", () => {
    process.env.CREDENTIALS_MASTER_KEY = "короткий-пароль";
    __resetMasterKeyForTests();
    const blob = encryptSecret("y")!;
    expect(decryptSecret(blob)).toBe("y");
  });

  it("hasCredentialCrypto: true при ключе", () => {
    expect(hasCredentialCrypto()).toBe(true);
  });

  it("самобутстрап мастер-ключа в файл при отсутствии env (изолированный data-каталог)", () => {
    delete process.env.CREDENTIALS_MASTER_KEY;
    const dir = `${process.env.TEMP || "/tmp"}/jarvis-key-${process.pid}-${Date.now()}`;
    process.env.JARVIS_DATA_DIR = dir;
    __resetMasterKeyForTests();
    try {
      expect(hasCredentialCrypto()).toBe(true); // сгенерил keyfile
      const blob = encryptSecret("z")!;
      expect(decryptSecret(blob)).toBe("z");
    } finally {
      delete process.env.JARVIS_DATA_DIR;
      __resetMasterKeyForTests();
    }
  });
});
