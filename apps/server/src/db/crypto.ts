/**
 * Шифрование секретов at-rest (§13, Фаза 6B / B4) — для per-user ключей интеграций в user_credentials.
 *
 * AES-256-GCM (аутентифицированное шифрование): подмена/порча блоба → провал расшифровки (null), а не
 * мусор. Формат блоба: [12 байт IV][16 байт authTag][ciphertext]. Мастер-ключ (32 байта):
 *   1) env CREDENTIALS_MASTER_KEY (hex-64 / base64 / любой пароль → sha256) — для инсталлера/hosted;
 *   2) иначе — сгенерированный и сохранённый файл `dataDir/credentials-master.key` (first-run,
 *      самобутстрап без зависимости от загрузки .env). Файл в data-каталоге (не в git).
 * Нет ключа НИ там, НИ там и сгенерировать не вышло → шифрование НЕДОСТУПНО (честный null, как
 * клиентский safeStorage keysSkipped): per-user ключи не хранятся, провайдеры берут .env-дефолт.
 *
 * ⚠️ Потеря мастер-ключа = все encrypted_blob нерасшифровываемы (это by design GCM). Ротация —
 * пере-сохранение секретов под новым ключом (вне scope B4-foundation).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import { dataDir } from "../paths.js";

const log: Logger = createLogger("crypto");
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null | undefined; // undefined = ещё не резолвили; null = недоступен

/** Привести произвольную строку-ключ к 32 байтам: hex-64 / base64(32) как есть, иначе sha256(passphrase). */
function coerceKey(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  // base64(32 байта) как есть. Buffer.from не бросает на не-base64 (лишние символы игнорит),
  // поэтому достаточно проверить длину — мимо неё падаем в sha256.
  const b = Buffer.from(raw, "base64");
  if (b.length === 32) return b;
  return createHash("sha256").update(raw, "utf8").digest(); // любой пароль → детерминированные 32 байта
}

/** Путь к самобутстрап-файлу мастер-ключа (в data-каталоге, не в git). */
function keyFilePath(): string {
  return join(dataDir(), "credentials-master.key");
}

/** Резолв мастер-ключа: env → файл → сгенерировать+сохранить. null — недоступен (шифрование off). */
function getMasterKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const env = (process.env.CREDENTIALS_MASTER_KEY ?? "").trim();
  if (env) {
    cachedKey = coerceKey(env);
    return cachedKey;
  }
  const file = keyFilePath();
  try {
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf8").trim();
      if (raw) {
        cachedKey = coerceKey(raw);
        return cachedKey;
      }
    }
    // first-run: генерируем 32 байта, сохраняем hex в файл (self-bootstrap).
    const key = randomBytes(32);
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(file, key.toString("hex"), { encoding: "utf8", mode: 0o600 });
    log.info("сгенерирован мастер-ключ кред (first-run)", { file });
    cachedKey = key;
    return cachedKey;
  } catch (e) {
    log.warn("мастер-ключ недоступен — шифрование кред выключено", { error: e instanceof Error ? e.message : String(e) });
    cachedKey = null;
    return null;
  }
}

/** Доступно ли шифрование (есть мастер-ключ). */
export function hasCredentialCrypto(): boolean {
  return getMasterKey() !== null;
}

/** Зашифровать секрет → блоб [IV][tag][ct]. null — шифрование недоступно (нет мастер-ключа). */
export function encryptSecret(plaintext: string): Buffer | null {
  const key = getMasterKey();
  if (!key) return null;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

/** Расшифровать блоб → секрет. null при недоступном ключе / порче / неверном ключе (GCM auth-fail). */
export function decryptSecret(blob: Buffer): string | null {
  const key = getMasterKey();
  if (!key || blob.length < IV_LEN + TAG_LEN) return null;
  try {
    const iv = blob.subarray(0, IV_LEN);
    const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = blob.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null; // неверный ключ / повреждённый/подменённый блоб
  }
}

/** Тест-сем: сбросить кеш ключа (между тестами с разным env/файлом). */
export function __resetMasterKeyForTests(): void {
  cachedKey = undefined;
}
