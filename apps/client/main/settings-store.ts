/**
 * Локальный стор настроек (вкладки «Общее»/«Ключи»). По образцу monitors.ts — persist на диск
 * в userData, без сервера. SRP: только хранение/чтение, ничего про UI и транспорт.
 *
 * Язык и контекст — обычным JSON. API-ключи — ШИФРОВАННО через Electron safeStorage (§12/§13):
 * на диск кладём base64 от safeStorage.encryptString; если ОС-шифрование недоступно — ключи НЕ
 * сохраняем (честно сообщаем вызывающему), чтобы не плодить секреты в plaintext.
 *
 * ВАЖНО (граница): этот стор хранит значения локально. Их ПОТРЕБЛЕНИЕ сервером (ключи провайдеров,
 * контекст в профиль) — отдельный слой (протокол+gateway), здесь не делается.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, safeStorage } from "electron";
import { createLogger } from "@jarvis/shared";
import type { KeyName, SettingsSnapshot, SettingsPatch, SettingsSaveResult } from "./ipc-contract.js";

const log = createLogger("settings");

const KEY_NAMES: readonly KeyName[] = ["anthropic", "eleven", "deepgram"];

interface PersistShape {
  language: string;
  context: string;
  /** name → base64(safeStorage.encryptString(value)). */
  keysEnc: Partial<Record<KeyName, string>>;
}

export class SettingsStore {
  private data: PersistShape = { language: "ru", context: "", keysEnc: {} };
  private readonly cfgPath: string;

  constructor(cfgPath?: string) {
    let base = process.cwd();
    try {
      base = app.getPath("userData"); // недоступен до app.ready — мягкий фоллбэк
    } catch {
      /* до ready */
    }
    this.cfgPath = cfgPath ?? join(base, "jarvis-settings.json");
    this.load();
  }

  /** Срез для UI: язык/контекст + флаги наличия ключей. */
  snapshot(): SettingsSnapshot {
    return {
      language: this.data.language,
      context: this.data.context,
      keys: {
        anthropic: Boolean(this.data.keysEnc.anthropic),
        eleven: Boolean(this.data.keysEnc.eleven),
        deepgram: Boolean(this.data.keysEnc.deepgram),
      },
    };
  }

  /** Расшифрованное значение ключа (для будущего потребления сервером). undefined — нет/не расшифровать. */
  getKey(name: KeyName): string | undefined {
    const enc = this.data.keysEnc[name];
    if (!enc || !this.encryptionAvailable()) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(enc, "base64"));
    } catch (e) {
      log.warn("не удалось расшифровать ключ", { name, err: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }

  /** Применить патч и сохранить. Возвращает честный отчёт. */
  save(patch: SettingsPatch): SettingsSaveResult {
    if (typeof patch.language === "string") this.data.language = patch.language;
    if (typeof patch.context === "string") this.data.context = patch.context;

    const encAvail = this.encryptionAvailable();
    const keysStored: KeyName[] = [];
    let keysSkipped = false;
    for (const name of KEY_NAMES) {
      const val = patch.keys?.[name]?.trim();
      if (!val) continue; // пусто = оставить прежний
      if (!encAvail) {
        keysSkipped = true; // не пишем секрет в plaintext
        continue;
      }
      try {
        this.data.keysEnc[name] = safeStorage.encryptString(val).toString("base64");
        keysStored.push(name);
      } catch (e) {
        keysSkipped = true;
        log.warn("не удалось зашифровать ключ", { name, err: e instanceof Error ? e.message : String(e) });
      }
    }

    try {
      mkdirSync(dirname(this.cfgPath), { recursive: true });
      writeFileSync(this.cfgPath, JSON.stringify(this.data), "utf8");
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log.warn("не удалось сохранить настройки", error);
      return { ok: false, encryptionAvailable: encAvail, keysStored: [], keysSkipped, error };
    }
    log.info("настройки сохранены", { language: this.data.language, keysStored, keysSkipped });
    return { ok: true, encryptionAvailable: encAvail, keysStored, keysSkipped };
  }

  private encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false; // safeStorage недоступен (до ready / не та платформа)
    }
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.cfgPath, "utf8")) as Partial<PersistShape>;
      if (typeof raw.language === "string") this.data.language = raw.language;
      if (typeof raw.context === "string") this.data.context = raw.context;
      if (raw.keysEnc && typeof raw.keysEnc === "object") {
        for (const name of KEY_NAMES) {
          const v = raw.keysEnc[name];
          if (typeof v === "string" && v) this.data.keysEnc[name] = v;
        }
      }
    } catch {
      /* нет файла — дефолт */
    }
  }
}

/** Синглтон стора настроек (на main-процесс). */
export const settingsStore = new SettingsStore();
