/**
 * Идентичность установки (§13, Фаза 6B / B2) — стабильный per-install UUID для ПАРТИЦИИ данных.
 *
 * ⚠️ ОПТ-ИН: UUID генерируется ТОЛЬКО при JARVIS_CLIENT_IDENTITY=1. По дефолту
 * getOrCreateInstallId() возвращает undefined → транспорт шлёт прежний 'dev-token' → сервер резолвит
 * DEV_USER → существующая установка НЕ теряет данные. Это главный регресс-гард: случайный UUID
 * по умолчанию осиротил бы раздел каждого текущего пользователя. «Вооружение» (флаг включён по
 * умолчанию / инсталлер выдаёт UUID) ложится в ОДНОМ релизе с B3 (партиция сторов), не раньше.
 *
 * UUID — НЕ секрет (на loopback токен это ключ партиции, не auth), поэтому храним ПЛОСКИМ JSON
 * (зеркало monitors.ts), без safeStorage: его недоступность не должна дать ЭФЕМЕРНУЮ идентичность →
 * новый раздел при каждом запуске. Атомарно tmp→rename. Кешируется на процесс (партиция не дрейфует
 * между reconnect). Сбой записи → undefined (фолбэк на dev-token), но НЕ эфемерный id.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { app } from "electron";
import { createLogger, envBool } from "@jarvis/shared";

const log = createLogger("identity-store");

interface Identity {
  installId: string;
}

export class IdentityStore {
  private readonly path: string;
  private cached: string | undefined;

  constructor(filePath?: string) {
    // userData недоступен до app.ready — мягкий фоллбэк на cwd (как monitors.ts/settings-store.ts).
    let base = process.cwd();
    try {
      base = app.getPath("userData");
    } catch {
      /* до ready */
    }
    this.path = filePath ?? join(base, "jarvis-identity.json");
  }

  /**
   * Стабильный per-install UUID — или undefined, если опт-ин (JARVIS_CLIENT_IDENTITY) выключен.
   * При включённом: читает с диска, иначе генерит + персистит. Никогда не бросает.
   */
  getOrCreateInstallId(): string | undefined {
    if (!envBool("JARVIS_CLIENT_IDENTITY")) return undefined;
    if (this.cached) return this.cached;

    try {
      if (existsSync(this.path)) {
        const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Identity>;
        if (raw && typeof raw.installId === "string" && raw.installId) {
          this.cached = raw.installId;
          return this.cached;
        }
      }
    } catch (e) {
      log.warn("не удалось прочитать идентичность — генерирую новую", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    const id = randomUUID();
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ installId: id } satisfies Identity, null, 2), "utf8");
      renameSync(tmp, this.path);
    } catch (e) {
      // Не смогли персистить → НЕ возвращаем эфемерный id (иначе новый раздел каждый запуск).
      // Честный фолбэк на dev-token (раздел не теряется).
      log.error("не удалось сохранить идентичность — фолбэк на dev-token", {
        error: e instanceof Error ? e.message : String(e),
      });
      return undefined;
    }
    this.cached = id;
    log.info("сгенерирована идентичность установки", { installId: id });
    return id;
  }
}

export const identityStore = new IdentityStore();
