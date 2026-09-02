/**
 * Device-токен продукта (jdt_…) — секрет: хранится ШИФРОВАННО через Electron safeStorage (как API-ключи в
 * settings-store), файл `jarvis-device-token.json` в userData. Нет шифрования ОС → не пишем (честно: false —
 * main логирует, после рестарта понадобится вход). Никогда не бросает: потеря токена = повторный вход,
 * а не падение клиента.
 *
 * Зачем (ревью 2026-09-02): сервер ротирует device-токен раз в 30 дней и присылает новый в server.hello;
 * старый доживает час. Без персиста клиент после рестарта предъявлял бы старый → login_required.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, safeStorage } from "electron";
import { createLogger } from "@jarvis/shared";

const log = createLogger("device-token");

export class DeviceTokenStore {
  private readonly path: string;
  /** undefined = ещё не читали; null = нет/не читается. */
  private cached: string | null | undefined;

  constructor(filePath?: string) {
    let base = process.cwd();
    try {
      base = app.getPath("userData");
    } catch {
      /* до ready */
    }
    this.path = filePath ?? join(base, "jarvis-device-token.json");
  }

  get(): string | undefined {
    if (this.cached !== undefined) return this.cached ?? undefined;
    try {
      if (!existsSync(this.path) || !safeStorage.isEncryptionAvailable()) {
        this.cached = null;
        return undefined;
      }
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { enc?: unknown };
      if (typeof raw?.enc !== "string" || !raw.enc) {
        this.cached = null;
        return undefined;
      }
      const v = safeStorage.decryptString(Buffer.from(raw.enc, "base64")).trim();
      this.cached = v.startsWith("jdt_") ? v : null;
    } catch (e) {
      log.warn("device-токен не прочитан — потребуется вход", { error: e instanceof Error ? e.message : String(e) });
      this.cached = null;
    }
    return this.cached ?? undefined;
  }

  /** true — записан шифрованно; false — шифрования ОС нет или диск не принял (в main — WARN, не падение). */
  set(raw: string): boolean {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify({ enc: safeStorage.encryptString(raw).toString("base64") }), "utf8");
      this.cached = raw;
      return true;
    } catch (e) {
      log.warn("device-токен не сохранён", { error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  clear(): void {
    this.cached = null;
    try {
      if (existsSync(this.path)) unlinkSync(this.path);
    } catch (e) {
      log.warn("device-токен не удалён", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

export const deviceTokenStore = new DeviceTokenStore();
