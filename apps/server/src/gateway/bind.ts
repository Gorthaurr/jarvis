/**
 * §6B/безопасность: выбор bind-адреса сервера. Вынесено из server.ts для юнит-теста без тяжёлого
 * импорта всего gateway (server.ts тянет провайдеры/anthropic/и т.д.).
 *
 * РЕАЛЬНАЯ граница loopback — это bind-адрес, НЕ токен: на 127.0.0.1 токен это ключ партиции
 * данных, любой локальный процесс под тем же пользователем ОС его переиграет (секрет = театр).
 * Поэтому единственный настоящий выигрыш безопасности на дефолте — не выпускать сервер за loopback
 * без явного opt-in.
 */
import type { Logger } from "@jarvis/shared";
import type { ServerConfig } from "../config.js";

/** Loopback-хост? (127.0.0.1 / ::1 / localhost / пусто). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "" || h === "127.0.0.1" || h === "::1" || h === "localhost";
}

/**
 * Хост для app.listen с гардом (§sec FAIL-CLOSED). Не-loopback bind разрешён ТОЛЬКО при
 * JARVIS_ALLOW_REMOTE И JARVIS_AUTH_STRICT одновременно — иначе LAN-сосед самопровижнит любой userId
 * (токен дремлет) и гонит ActionCommand → RCE на ПК. Раньше при allowRemote && !authStrict лишь
 * ПРЕДУПРЕЖДАЛИ и всё равно слушали наружу (fail-open, H8) — теперь принудительно 127.0.0.1 + error
 * (сервер ДОЛЖЕН подняться, не падать; просто не выходит за loopback без strict-auth). TLS — на
 * reverse-proxy перед сервером (отдельно). Инвариант: remote ⇒ strict auth.
 */
export function resolveBindHost(config: Pick<ServerConfig, "host" | "allowRemote" | "authStrict">, log: Logger): string {
  if (isLoopbackHost(config.host)) {
    // Пустой/пробельный host в Node = bind на ВСЕ интерфейсы. Гард сам нормализует его в loopback,
    // чтобы «loopback»-ветка НИКОГДА не отдала wildcard (не полагаемся на то, что env() свернёт "" выше).
    return config.host.trim() === "" ? "127.0.0.1" : config.host;
  }
  if (!config.allowRemote) {
    log.error("ОТКАЗ: HOST не loopback без JARVIS_ALLOW_REMOTE — принудительно слушаю 127.0.0.1", {
      host: config.host,
    });
    return "127.0.0.1";
  }
  if (!config.authStrict) {
    // FAIL-CLOSED (H8): remote без strict-auth = неаутентифицированный пульт RCE для LAN. НЕ выпускаем.
    log.error("ОТКАЗ: HOST не loopback + JARVIS_ALLOW_REMOTE, но JARVIS_AUTH_STRICT=0 — это пульт RCE без авторизации; принудительно слушаю 127.0.0.1. Включи JARVIS_AUTH_STRICT=1 для remote.", {
      host: config.host,
    });
    return "127.0.0.1";
  }
  return config.host;
}
