/**
 * §Волна2 (2.6) — Пост-STT нормализатор лексики: доменные слова, которые STT отрендерил
 * ЛАТИНИЦЕЙ («в dot'е», «открой youtube music»), приводятся к кириллице ДО gateWake/роутера —
 * это разом лечит tier0, recall навыков и дубль-гейт (все матчатся по кириллице).
 *
 * ПРИНЦИП §13 (name-match): транслитерация = RECALL-расширение, а не «исправление речи».
 * Токен трогаем ТОЛЬКО если: (а) он содержит латиницу И (б) его кириллический рендеринг
 * узнаваем лексиконом (точное совпадение или словоформа lev≤1: доте↔дота). Неизвестная
 * латиница (GitHub, ffmpeg) остаётся КАК ЕСТЬ — пользователь мог назвать реальный
 * англоязычный термин. Замена = кириллический рендеринг САМОГО токена (словоформа
 * сохраняется: dot'е→доте, НЕ →«дота»).
 *
 * Источники лексикона: статика роутера (QUICK_ALIASES/WEB_SERVICES), приложения/игры из
 * client.env, имена/триггеры выученных навыков. Сборка ЛЕНИВАЯ и ФОНОВАЯ (TTL) —
 * normalize() строго синхронный (gateWake синхронный); до первой сборки текст идёт как есть.
 */
import { createLogger, foldText, latinToCyrillic } from "@jarvis/shared";

const log = createLogger("lexicon");

/** Минимальная длина ключа лексикона: короче — слишком шумно для lev-матча словоформ. */
const MIN_KEY_LEN = 3;
/** lev≤1-матч словоформ разрешаем только от этой длины (иначе «вк»↔«вс» и подобный мусор). */
const MIN_FUZZY_LEN = 4;
/** Кап размера лексикона — защита от разбухания (перебор ключей на каждый латинский токен). */
const MAX_KEYS = 600;

/** Расстояние Левенштейна ≤1? (ранний выход; только для коротких доменных слов). */
export function withinLev1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  // Одна замена / вставка / удаление — линейный проход двумя указателями.
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (la === lb) {
      i += 1;
      j += 1; // замена
    } else if (la > lb) {
      i += 1; // удаление из a
    } else {
      j += 1; // вставка в a
    }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

/**
 * Построить лексикон из списка терминов: ключи — свёрнутые (foldText) токены терминов и их
 * кириллические рендеринги. Чистая функция.
 */
export function buildLexicon(terms: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const term of terms) {
    if (keys.size >= MAX_KEYS) break;
    for (const rawTok of foldText(String(term ?? "")).split(" ")) {
      const tok = rawTok.trim();
      if (tok.length < MIN_KEY_LEN) continue;
      keys.add(tok);
      // Латинский термин («dota») добавляем и кириллическим рендерингом («дота») —
      // recall в обе стороны, как transliterate в name-match §13.
      if (/[a-z]/.test(tok)) {
        const cyr = foldText(latinToCyrillic(tok)).replace(/\s+/g, "");
        if (cyr.length >= MIN_KEY_LEN) keys.add(cyr);
      }
    }
  }
  return keys;
}

/** Токен-кандидат на нормализацию: содержит латиницу (чисто-кириллические НЕ трогаем — §13). */
const HAS_LATIN = /[a-z]/i;
/** Апострофы STT-артефактов («dot'е») — срезаются перед рендерингом (как в router-гейте). */
const APOSTROPHES = /['’ʼ`]/gu;

/**
 * Нормализовать транскрипт по лексикону (чистая, синхронная): латинские/смешанные токены,
 * чей кириллический рендеринг узнаваем лексиконом, заменяются рендерингом (словоформа
 * сохраняется). Разделители/регистр остального текста не трогаются.
 */
export function normalizeTranscript(text: string, lexicon: ReadonlySet<string>): string {
  if (!text || lexicon.size === 0) return text;
  let changed = false;
  const out = text.split(/(\s+)/u).map((part) => {
    if (!part || /^\s+$/u.test(part) || !HAS_LATIN.test(part)) return part;
    // Хвостовая пунктуация сохраняется («dot'е.» → «доте.»).
    const m = /^(.*?)([.,!?…;:]*)$/u.exec(part);
    const core = m?.[1] ?? part;
    const tail = m?.[2] ?? "";
    const stripped = core.replace(APOSTROPHES, "");
    if (!stripped || !HAS_LATIN.test(stripped)) return part;
    // Ревью Волны 2: токен, который САМ ПО СЕБЕ известен лексикону латиницей («youtube», «dota»),
    // НЕ трогаем — даунстрим-матчеры (QUICK_ALIASES/WEB_SERVICES/резолвер) знают эти написания, а
    // фонетический рендеринг («ёутубе») их ломал. Конвертируем только НЕузнанную латиницу.
    const rawKey = foldText(stripped).replace(/\s+/g, "");
    if (rawKey && lexicon.has(rawKey)) return part;
    const cyr = latinToCyrillic(stripped);
    const key = foldText(cyr).replace(/\s+/g, "");
    if (key.length < MIN_KEY_LEN) return part;
    let hit = lexicon.has(key);
    if (!hit && key.length >= MIN_FUZZY_LEN) {
      for (const k of lexicon) {
        if (k.length >= MIN_FUZZY_LEN && withinLev1(key, k)) {
          hit = true;
          break;
        }
      }
    }
    if (!hit) return part; // неизвестная латиница (GitHub/ffmpeg) — не трогаем
    changed = true;
    return cyr + tail;
  });
  const result = out.join("");
  if (changed) log.info("транскрипт нормализован по лексикону (§Волна2 2.6)", { from: text.slice(0, 60), to: result.slice(0, 60) });
  return result;
}

/** Источник терминов лексикона: sync-массив или промис (навыки из БД). */
export type LexiconSource = () => readonly string[] | Promise<readonly string[]>;

/** TTL пересборки лексикона — навыки/окружение меняются редко. */
const REBUILD_TTL_MS = 60_000;

/**
 * Stateful-нормализатор: копит лексикон из источников ЛЕНИВО (fire-and-forget пересборка по TTL),
 * normalize() всегда синхронный — отдаёт по последнему собранному словарю (до первой сборки —
 * текст как есть; сборка запускается первым же вызовом).
 */
export class TranscriptNormalizer {
  private lexicon: Set<string> = new Set();
  private builtAt = 0;
  private building = false;

  constructor(private readonly sources: readonly LexiconSource[]) {}

  /** Синхронная нормализация по последнему собранному лексикону (+ фоновый rebuild по TTL). */
  normalize(text: string): string {
    this.maybeRebuild();
    return normalizeTranscript(text, this.lexicon);
  }

  /** Текущий размер лексикона (диагностика/тесты). */
  get size(): number {
    return this.lexicon.size;
  }

  private maybeRebuild(): void {
    if (this.building || Date.now() - this.builtAt < REBUILD_TTL_MS) return;
    this.building = true;
    void (async () => {
      try {
        const all: string[] = [];
        for (const src of this.sources) {
          try {
            // Ревью Волны 2: зависший источник (БД) не должен навсегда запереть пересборку —
            // потолок 3с на источник, дальше строим из остальных.
            const terms = await Promise.race<readonly string[]>([
              Promise.resolve(src()),
              new Promise<readonly string[]>((_, rej) => {
                const t = setTimeout(() => rej(new Error("lexicon source timeout")), 3_000);
                (t as { unref?: () => void }).unref?.();
              }),
            ]);
            all.push(...terms);
          } catch {
            /* источник упал/завис (БД/сеть) — строим из остальных */
          }
        }
        this.lexicon = buildLexicon(all);
        this.builtAt = Date.now();
        log.debug("лексикон собран", { keys: this.lexicon.size });
      } catch (e) {
        // Ревью: throw из buildLexicon не должен стать unhandled rejection у void-промиса.
        log.warn("сборка лексикона упала", { error: e instanceof Error ? e.message : String(e) });
      } finally {
        this.building = false;
      }
    })();
  }
}
