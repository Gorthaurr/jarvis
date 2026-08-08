/**
 * KILLSWITCH АВТОНОМИИ (волна E, идея Skales, дизайн под НАШ супервизор): durable-латч
 * `dataDir/autonomy-freeze.json`. Пока латч стоит, замирает всё ТАЙМЕРНОЕ/СОБЫТИЙНОЕ:
 * watch-тики (вкл. отложенные поручения), ambient-опросы, авто-предиктор, сон-цикл консолидации,
 * рефлексы памяти/обязательств. Сервер ЖИВ, реплики владельца обрабатываются ШТАТНО (петля,
 * авто-реплей, инструменты — это ответ на его команду, не автономия); напоминания НЕ глушатся —
 * они заказаны владельцем на конкретное время («разбуди в 3» обязан сработать), и ack команды
 * честно это проговаривает.
 *
 * Почему латч-файл, а не «убить сервер»: супервизор поднимет сервер через 1с, а «Джарвис молчит»
 * хуже, чем «Джарвис ждёт команд». Латч переживает рестарт; запись/удаление файла инструментами
 * агента заблокированы self-guard клиента (POLICY_BASENAMES) — снять СВОЙ стоп агент не может,
 * снимает только владелец командой.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import { dataDir } from "../paths.js";

const log: Logger = createLogger("autonomy");

export interface FreezeInfo {
  frozenAt: number;
  reason: string;
}

export class AutonomyFreeze {
  private cache: FreezeInfo | null | undefined; // undefined = файл ещё не читали
  constructor(private readonly dir: string = dataDir()) {}

  private get file(): string {
    return join(this.dir, "autonomy-freeze.json");
  }

  info(): FreezeInfo | null {
    if (this.cache === undefined) {
      try {
        this.cache = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as FreezeInfo) : null;
      } catch {
        // Битый файл = ЛАТЧ СТОИТ (fail-closed): аварийный стоп не должен сниматься порчей JSON.
        this.cache = { frozenAt: 0, reason: "файл латча повреждён — считаю остановленным (fail-closed)" };
      }
    }
    return this.cache;
  }

  isFrozen(): boolean {
    return this.info() !== null;
  }

  /**
   * true — латч durable (переживёт рестарт). false — диск не принял: стоп действует ТОЛЬКО в этом
   * процессе (кэш), после рестарта автономия возобновится — ack обязан сказать это владельцу честно
   * (контроль-ревью волны E: безусловное «переживёт и перезапуск» было ложным успехом; зеркало unfreeze).
   */
  freeze(reason: string): boolean {
    const info: FreezeInfo = { frozenAt: Date.now(), reason };
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(info), "utf8");
      renameSync(tmp, this.file);
    } catch (e) {
      // Диск не принял — стоп всё равно ДЕЙСТВУЕТ в этом процессе (кэш ниже), но рестарта не переживёт.
      log.warn("латч killswitch не записался на диск — стоп не переживёт рестарт", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    this.cache = info;
    log.warn("АВТОНОМИЯ ОСТАНОВЛЕНА владельцем (killswitch)", { reason });
    return existsSync(this.file);
  }

  /** true — латч снят (вкл. диск). false — файл не удалился: после рестарта стоп ВЕРНЁТСЯ (говорим честно). */
  unfreeze(): boolean {
    try {
      rmSync(this.file, { force: true });
    } catch (e) {
      log.warn("файл латча killswitch не удалился", { error: e instanceof Error ? e.message : String(e) });
    }
    this.cache = null; // в ЭТОМ процессе автономия включена в любом случае
    const gone = !existsSync(this.file);
    if (gone) log.info("автономия включена обратно владельцем");
    else log.warn("латч не снят С ДИСКА — после рестарта автономия снова замрёт");
    return gone;
  }
}

let singleton: AutonomyFreeze | undefined;
/** Ленивый синглтон (грабля «.env грузится после ESM-хойст-импортов» — dataDir читается при первом зове). */
export function autonomyFreeze(): AutonomyFreeze {
  if (!singleton) singleton = new AutonomyFreeze();
  return singleton;
}
/** Тестам: подменить/сбросить синглтон (изолированный каталог). */
export function setAutonomyFreezeForTests(f: AutonomyFreeze | undefined): void {
  singleton = f;
}

// ── Команды владельца ────────────────────────────────────────────────────────
// Позитивный ANCHORED-матч (урок lean-smalltalk: блоклисты неполны, allowlist точных форм безопасен).
// «стоп»/«останови задачу» сюда НЕ попадают — это штатное управление задачами/плеером.
const FREEZE_RE =
  /^(?:полный|аварийный)\s+стоп$|^стоп\s+(?:вся\s+)?автономи[яию]$|^(?:останови|выключи|отключи|заморозь)\s+(?:всю\s+)?автономию$/;
const UNFREEZE_RE =
  /^(?:включи|верни|запусти)\s+автономию(?:\s+обратно)?$|^сними\s+(?:полный|аварийный)\s+стоп$|^разморозь\s+автономию$/;

/** Распознать команду killswitch в УЖЕ нормализованной реплике (без wake-слова/филлеров). */
export function matchAutonomyCommand(normalized: string): "freeze" | "unfreeze" | null {
  const t = normalized.trim().toLowerCase().replace(/[.!?]+$/u, "").trim();
  if (FREEZE_RE.test(t)) return "freeze";
  if (UNFREEZE_RE.test(t)) return "unfreeze";
  return null;
}
