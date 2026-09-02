/**
 * HMAC-перец для email_hash — ОБЯЗАН быть durable: смена перца между рестартами = все аккаунты «исчезают»
 * (findUserByEmailHash пуст → вход создаёт дубли, подписки/инвойсы сиротеют). Ревью 2026-09-02 поймало ровно
 * это (публичная dev-константа на первом boot, производная ключа на втором); контроль-ревью — второй раз:
 * добавленный позже CREDENTIALS_MASTER_KEY молча менял перец, обгоняя уже созданный файл.
 *
 * Правило: ЕДИНСТВЕННЫЙ источник истины после первого boot — файл `dataDir/email-pepper.key` (бэкапить!).
 * Первый boot пишет в него применённый перец (из JARVIS_EMAIL_PEPPER → CREDENTIALS_MASTER_KEY → случайный).
 * Дальше env лишь СВЕРЯЕТСЯ: расхождение = отказ старта с текстом (fail-closed), а не тихая смена.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import { lazyDataPath } from "../paths.js";

const log: Logger = createLogger("product:pepper");
const pepperFile = lazyDataPath("email-pepper.key");

let cached: string | undefined;

function derivedFromEnv(env: NodeJS.ProcessEnv): { value: string; source: string } | null {
  const explicit = (env.JARVIS_EMAIL_PEPPER ?? "").trim();
  if (explicit) return { value: createHash("sha256").update(explicit, "utf8").digest("hex"), source: "JARVIS_EMAIL_PEPPER" };
  const master = (env.CREDENTIALS_MASTER_KEY ?? "").trim();
  if (master) return { value: createHmac("sha256", master).update("jarvis:email-pepper:v1").digest("hex"), source: "CREDENTIALS_MASTER_KEY" };
  return null;
}

/** Перец (hex, 64 символа). Детерминирован на протяжении жизни установки. Бросает, если durable-источника нет или он расходится с env. */
export function resolvePepper(env: NodeJS.ProcessEnv = process.env): string {
  if (cached) return cached;
  const p = pepperFile();
  const derived = derivedFromEnv(env);
  if (existsSync(p)) {
    const v = readFileSync(p, "utf8").trim();
    if (!/^[0-9a-f]{64}$/i.test(v)) throw new Error(`email-pepper.key повреждён (${p}) — восстановите из бэкапа, иначе все аккаунты станут недоступны`);
    if (derived && derived.value !== v.toLowerCase()) {
      throw new Error(
        `перец из ${derived.source} не совпадает с ${p}: аккаунты созданы с перцем из файла. Уберите переменную или верните прежнее значение — молчаливая смена перца обнулила бы все аккаунты`,
      );
    }
    return (cached = v.toLowerCase());
  }
  const fresh = derived?.value ?? randomBytes(32).toString("hex");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, fresh, { encoding: "utf8", mode: 0o600 });
  log.warn("email-pepper.key создан впервые — БЭКАПИТЬ вместе с credentials-master.key (потеря = потеря всех аккаунтов)", { path: p, source: derived?.source ?? "random" });
  return (cached = fresh);
}

/** Только для тестов: сбросить кэш (иначе env-перец из одного теста утечёт в другой). */
export function __resetPepperForTests(): void {
  cached = undefined;
}
