/**
 * Идентичность пользователя (§13, Фаза 6B мультитенант) — ШОВ вместо хардкода.
 *
 * Было: `const userId = "00000000-…-0001"` для ВСЕХ коннектов (все юзеры одного инстанса делили один
 * раздел данных — корень мультитенант-блокера из аудита). Здесь резолвим userId из токена client.hello:
 *  • токен — валидный UUID → это per-install идентификатор клиента → ЕГО раздел данных (партиция).
 *  • иначе → dev-фолбэк (env JARVIS_DEV_USER_ID или seed) — поведение текущей установки НЕ меняется.
 *
 * ⚠️ Это ПАРТИЦИЯ данных, НЕ аутентификация: сервер слушает loopback (config.host=127.0.0.1), так что
 * клиент локальный и доверенный. РЕАЛЬНАЯ валидация токена РЕАЛИЗОВАНА в db/users.ts, но ДРЕМЛЕТ на
 * loopback (JARVIS_AUTH_STRICT=0, дефолт) — секрет/HMAC здесь был бы театром (локальный процесс
 * переиграет токен). Реальная граница loopback — это bind-адрес (server.ts listen-гард). Парный шаг —
 * клиент генерит+хранит стабильный UUID на первом запуске и шлёт его как token (ОПТ-ИН за
 * JARVIS_CLIENT_IDENTITY; дефолт «dev-token» → DEV_USER, нулевая потеря данных существующей установки).
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { isDbReady } from "../db/pool.js";
import { ensureUser, findUserByTokenHash, recordToken, sha256hex } from "../db/users.js";

const log: Logger = createLogger("identity");

const DEV_USER = "00000000-0000-0000-0000-000000000001";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s.trim());
}

/** Булев флаг из переданного env (для тестируемости без мутации process.env). */
function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = (env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Резолв userId из токена (ЧИСТЫЙ, без БД). UUID → раздел клиента; иначе JARVIS_DEV_USER_ID (UUID) → он; иначе seed. */
export function resolveUserId(token: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const t = (token ?? "").trim();
  if (isUuid(t)) return t.toLowerCase();
  const dev = (env.JARVIS_DEV_USER_ID ?? "").trim();
  if (isUuid(dev)) return dev.toLowerCase();
  return DEV_USER;
}

/**
 * Резолв userId + lazy-provision строки users (async-обёртка над resolveUserId).
 * Вызывается в handshake ДО createOrResume → FK-родитель существует к моменту per-user записей.
 * НИКОГДА не бросает (зеркалит null-безопасность pool.query).
 *
 *  • Дефолт (loopback, JARVIS_AUTH_STRICT=0): UUID-токен → чистый ключ партиции (TOFU); провижним
 *    users + записываем auth_tokens (TOFU/last_seen). Возвращаем userId. 4003 НИКОГДА не срабатывает.
 *  • STRICT (JARVIS_AUTH_STRICT=1, LAN/hosted): UUID сверяется с auth_tokens по sha256(token). Нет
 *    строки И БД доступна → null (handshake закроет 4003). БД недоступна → НЕ закрываем (не брикуем
 *    локального юзера) — провижним и пускаем как партицию, логируя «accepted unverified».
 *  • Не-UUID (dev-token/пусто/мусор) → dev-фолбэк (как раньше); провижним DEV_USER (идемпотентно).
 */
export async function resolveAndProvision(
  token: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const t = (token ?? "").trim();
  const strict = flag(env, "JARVIS_AUTH_STRICT");

  if (isUuid(t)) {
    const userId = t.toLowerCase();
    const hash = sha256hex(userId);
    if (strict) {
      const found = await findUserByTokenHash(hash);
      if (found) {
        void recordToken(found, hash); // best-effort бамп last_seen
        return found;
      }
      if (await isDbReady()) {
        log.warn("strict: токен не найден в auth_tokens — отклоняю", { userId });
        return null; // strict + БД есть + нет строки → reject (4003)
      }
      log.warn("strict: БД недоступна — пускаю без верификации (не брикуем локального юзера)", { userId });
      // fall-through: провижн + партиция
    }
    await ensureUser(userId);
    await recordToken(userId, hash); // TOFU: запоминаем/обновляем токен
    return userId;
  }

  // Не-UUID → dev-фолбэк (поведение существующей установки неизменно). auth_tokens-строку НЕ пишем.
  const userId = resolveUserId(t, env);
  await ensureUser(userId);
  return userId;
}

export { DEV_USER };
