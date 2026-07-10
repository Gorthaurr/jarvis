/**
 * Хранилище голосовых отпечатков (§3 «kill-фича»). Профили дикторов («Антон», «Катя»)
 * персистятся в data/voices.json и переживают рестарт — как profile.json. Хранится ИМЯ +
 * опачные байты профиля движка (base64), НЕ запись голоса (приватность: отпечаток необратим
 * к аудио). Без файла — пусто (гейт диктора выключен, реагируем на всех).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import { dataPath } from "../../paths.js";
import type { VoiceProfile } from "./verifier.js";

const log: Logger = createLogger("speaker:store");
const VOICES_PATH = dataPath("voices.json"); // §универсальность: JARVIS_DATA_DIR → иначе cwd/data

// §мультитенант: seed-пользователь (зеркало gateway/identity.ts DEV_USER / brain/profile.ts) — legacy
// профили без userId относим к нему (континьюити: записанный голос Антона не теряется при партиции).
const DEV_USER = "00000000-0000-0000-0000-000000000001";

/** Сериализуемая форма профиля (data — base64). */
interface StoredVoice {
  name: string;
  data: string; // base64
  createdAt: number;
  /** §3 Фаза 0: размерность эмбеддинга + ИД модели — для отбраковки профиля при смене модели. */
  dim?: number;
  modelId?: string;
  /** §мультитенант: владелец отпечатка. legacy-профиль без поля → DEV_USER (континьюити). */
  userId?: string;
}

/** Профиль с владельцем (внутренняя форма): VoiceProfile + userId для партиции по юзеру. */
type OwnedProfile = VoiceProfile & { userId: string };

/** Метаданные модели отпечатка, которой записан профиль (Фаза 0). */
export interface VoiceModelMeta {
  dim: number;
  modelId: string;
}

/** Файловое хранилище голосовых профилей. Загрузка один раз, мутации персистятся. */
export class VoiceProfileStore {
  private profiles: OwnedProfile[] = [];

  /** Путь к файлу хранилища (инъекция для тестов; по умолчанию data/voices.json). */
  constructor(private readonly filePath: string = VOICES_PATH) {}

  /** Загрузить с диска (один раз на старте). Безопасно при отсутствии файла. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch {
      // Файла нет (ENOENT) — штатное «голосов ещё не записывали».
      this.profiles = [];
      log.info("голосовых отпечатков нет (гейт диктора выключен — реагируем на всех)");
      return;
    }
    try {
      const raw = JSON.parse(text) as StoredVoice[];
      this.profiles = raw
        .filter((v) => v && typeof v.name === "string" && typeof v.data === "string")
        .map((v) => {
          const data = fromBase64(v.data);
          return {
            name: v.name,
            data,
            createdAt: Number(v.createdAt) || Date.now(),
            // legacy-профиль без dim → выводим из длины байт (float32); modelId оставляем как есть
            // (undefined трактуется как «совместим» — не ломаем уже записанный профиль Антона).
            dim: typeof v.dim === "number" ? v.dim : data.byteLength >> 2,
            modelId: typeof v.modelId === "string" ? v.modelId : undefined,
            // §мультитенант: legacy-профиль без userId → DEV_USER (континьюити записанного голоса).
            userId: typeof v.userId === "string" && v.userId ? v.userId : DEV_USER,
          };
        });
      log.info("голосовые отпечатки загружены", { count: this.profiles.length, names: this.profiles.map((p) => p.name) });
    } catch (e) {
      // Файл ЕСТЬ, но не парсится — повреждён (обрыв записи/диск). НЕ молчим как «голосов нет»:
      // это тихо выключило бы гейт. Громкий error + бэкап файла, чтобы не затереть улику.
      this.profiles = [];
      log.error("voices.json повреждён — голоса не загружены (гейт диктора выключен)", e instanceof Error ? e.message : String(e));
      try {
        await rename(this.filePath, `${this.filePath}.corrupt`);
      } catch {
        /* бэкап не вышел — не критично */
      }
    }
  }

  /** Профили КОНКРЕТНОГО юзера (для его гейта диктора и UI). §мультитенант: голоса партиционированы. */
  list(userId: string): readonly VoiceProfile[] {
    return this.profiles.filter((p) => p.userId === userId);
  }

  /** Есть ли у юзера хоть один enrolled-голос (иначе его гейт диктора выключен — слышим всех). */
  hasAny(userId: string): boolean {
    return this.profiles.some((p) => p.userId === userId);
  }

  /** Всего профилей во всех разделах (для boot-лога/диагностики). */
  get total(): number {
    return this.profiles.length;
  }

  /** Добавить/заменить профиль по имени (повторный enrollment имени — обновление). meta — модель
   *  отпечатка (dim+modelId, Фаза 0): без неё профиль нельзя надёжно отбраковать при смене модели. */
  async add(userId: string, name: string, data: Uint8Array, meta?: VoiceModelMeta): Promise<VoiceProfile> {
    const clean = name.trim();
    const profile: OwnedProfile = {
      userId,
      name: clean,
      data,
      createdAt: Date.now(),
      dim: meta?.dim ?? data.byteLength >> 2,
      modelId: meta?.modelId,
    };
    // Upsert в пределах ВЛАДЕЛЬЦА: имена уникальны per-user (у разных юзеров может быть «Антон»).
    const idx = this.profiles.findIndex((p) => p.userId === userId && p.name.toLowerCase() === clean.toLowerCase());
    if (idx >= 0) this.profiles[idx] = profile;
    else this.profiles.push(profile);
    await this.persist();
    log.info("голос записан", { userId, name: clean, ownerVoices: this.list(userId).length });
    return profile;
  }

  /** Удалить профиль юзера по имени. true — был и удалён. */
  async remove(userId: string, name: string): Promise<boolean> {
    const before = this.profiles.length;
    const lc = name.trim().toLowerCase();
    this.profiles = this.profiles.filter((p) => !(p.userId === userId && p.name.toLowerCase() === lc));
    if (this.profiles.length === before) return false;
    await this.persist();
    log.info("голос удалён", { userId, name, ownerVoices: this.list(userId).length });
    return true;
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const out: StoredVoice[] = this.profiles.map((p) => ({
        name: p.name,
        data: toBase64(p.data),
        createdAt: p.createdAt,
        userId: p.userId, // §мультитенант: владелец отпечатка
        ...(p.dim !== undefined ? { dim: p.dim } : {}),
        ...(p.modelId !== undefined ? { modelId: p.modelId } : {}),
      }));
      // Атомарно: пишем во временный файл и переименовываем (rename атомарен в пределах ФС).
      // Краш посреди записи tmp оставит целым старый voices.json, а не битый огрызок.
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, JSON.stringify(out, null, 2), "utf8");
      await rename(tmp, this.filePath);
    } catch (e) {
      log.warn("не удалось сохранить голоса", e instanceof Error ? e.message : String(e));
    }
  }
}

function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}
function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
