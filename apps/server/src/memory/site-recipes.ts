/**
 * §AX-Ref: РЕЦЕПТЫ САЙТОВ — доменное знание как ДАННЫЕ, а не хардкод в движке расширения.
 *
 * Диагноз редизайна: «на Яндекс.Музыке заебись, на других говно» — потому что приёмы Я.Музыки были
 * ЗАХАРДКОЖЕНЫ в background.js (/yandex/.test → location.href, aria «Воспроизведение/Пауза», [class*='Wheel']).
 * Тут это знание живёт РЕЦЕПТОМ-ХИНТОМ, рекуллимым по ТОЧНОМУ hostname (map-lookup, мимо шумного e5-small —
 * семантический recall путал платформы). Рецепт = ПОДСКАЗКА модели (она исполняет через browser_inspect/act/
 * batch с ref-адресацией и сверкой исхода), а НЕ слепой реплей селектор-цепочки → replay-gate не задет.
 *
 * Знание про сайт ОБЩЕЕ (не per-user), как shared-навыки: успешный приём на youtube.com полезен всем.
 * Ключ — нормализованный host (без www.). Seed курируется; upsert/reinforce/demote — API для авто-обучения
 * (владелец включает распознавание успешного прохода отдельно; forget по failCount уже здесь).
 *
 * Зеркалит persist-паттерн resolution-memory.ts (атомарно tmp→rename, дебаунс, flush на close). Чистая
 * логика (recall/upsert/reinforce/demote/TTL) тестируется без диска.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../paths.js";
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("site-recipes");
const FILE_NAME = "site-recipes.json";
const SAVE_DEBOUNCE_MS = 300;
const MAX_ENTRIES = 500;
/** Рецепт, проваленный ≥ этого числа раз, recall больше НЕ подсовывает (учится на ошибках). Реюз идеи SKILL_FAIL_SUPPRESS. */
const FAIL_SUPPRESS = Number.parseInt(process.env.JARVIS_SITE_RECIPE_FAIL_SUPPRESS ?? "", 10) || 3;

export type RecipeSource = "seed" | "learned";

export interface SiteRecipe {
  /** Нормализованный host (без www.), напр. "music.yandex.ru". */
  host: string;
  /** Проза-подсказка «как на этом сайте делать X» — ДАННЫЕ, инжектятся хинтом. */
  hint: string;
  source: RecipeSource;
  /** Провалы подряд: ≥ FAIL_SUPPRESS → recall молчит (self-heal). Успех сбрасывает. */
  failCount: number;
  updatedAt: number;
}

/** Нормализация host: без схемы, без www., lowercase. Голый host от модели тоже принимаем. */
export function normalizeHost(input: string): string {
  const raw = String(input || "").trim();
  if (!raw) return "";
  try {
    const s = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(s).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return raw.replace(/^www\./, "").toLowerCase().split("/")[0] ?? "";
  }
}

/**
 * Хранилище рецептов. Чистая логика (без диска) — юнит-тесты; персист навешивает loadSiteRecipeStore.
 */
export class SiteRecipeStore {
  private readonly map = new Map<string, SiteRecipe>();
  private onChange?: () => void;
  constructor(private readonly now: () => number = () => Date.now()) {}

  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  /** Рецепт для host (точное совпадение), если он НЕ подавлен провалами. null — молчим. */
  recall(host: string): SiteRecipe | null {
    const h = normalizeHost(host);
    if (!h) return null;
    const r = this.map.get(h);
    if (!r) return null;
    if (r.failCount >= FAIL_SUPPRESS) return null; // учится на ошибках — не подсовывает провальный приём
    return r;
  }

  /** Записать/обновить рецепт. Seed не перетирается learned'ом (курируемое знание главнее авто-выученного). */
  upsert(host: string, hint: string, source: RecipeSource = "learned"): void {
    const h = normalizeHost(host);
    const text = String(hint || "").trim().slice(0, 1000);
    if (!h || !text) return;
    const prev = this.map.get(h);
    if (prev && prev.source === "seed" && source === "learned") return; // не даём авто-обучению затирать seed
    this.map.set(h, { host: h, hint: text, source, failCount: 0, updatedAt: this.now() });
    this.evict();
    this.onChange?.();
  }

  /** Успешный проход по рецепту — сбросить счётчик провалов (надёжный приём восстанавливается). */
  reinforce(host: string): void {
    const r = this.map.get(normalizeHost(host));
    if (r && r.failCount > 0) {
      r.failCount = 0;
      r.updatedAt = this.now();
      this.onChange?.();
    }
  }

  /** Провал по рецепту — +1; при исчерпании recall замолкает (не повторяем провальный приём). */
  demote(host: string): void {
    const r = this.map.get(normalizeHost(host));
    if (!r) return;
    r.failCount += 1;
    r.updatedAt = this.now();
    this.onChange?.();
  }

  /** Вытеснение старейшего сверх MAX_ENTRIES (seed не трогаем в первую очередь). */
  private evict(): void {
    if (this.map.size <= MAX_ENTRIES) return;
    const learned = [...this.map.values()].filter((r) => r.source === "learned").sort((a, b) => a.updatedAt - b.updatedAt);
    while (this.map.size > MAX_ENTRIES && learned.length) {
      const oldest = learned.shift();
      if (oldest) this.map.delete(oldest.host);
    }
  }

  toJSON(): SiteRecipe[] {
    return [...this.map.values()];
  }

  restore(rows: SiteRecipe[]): void {
    for (const r of rows || []) {
      const h = normalizeHost(r?.host || "");
      if (h && typeof r.hint === "string") {
        this.map.set(h, { host: h, hint: r.hint, source: r.source === "seed" ? "seed" : "learned", failCount: Number(r.failCount) || 0, updatedAt: Number(r.updatedAt) || this.now() });
      }
    }
  }
}

/** Курируемые стартовые рецепты — доменное знание, ПЕРЕЕХАВШЕЕ из хардкода в данные. Идемпотентны (seed). */
export function seedSiteRecipes(store: SiteRecipeStore): void {
  const SEED: Array<{ host: string; hint: string }> = [
    {
      host: "music.yandex.ru",
      hint:
        "Веб-плеер Яндекс.Музыки. play/pause — кнопка с aria-label «Воспроизведение»/«Пауза» (media-элемента нет, " +
        "стрим через MSE; состояние читай по самому aria-label). «Моя волна»: если клик по пункту меню НЕ переключает " +
        "страницу — сделай browser_open music.yandex.ru/ и затем play. «Встряхнуть» тасует подборку ТОЛЬКО у играющей " +
        "волны. Плитки колеса тоже имеют aria «Воспроизведение» — бери именно ГЛОБАЛЬНУЮ кнопку плеера (по ref из inspect). " +
        "Сверь исход: aria-label кнопки флипнулся Воспроизведение→Пауза; не флипнулся — autoplay, нужен живой клик, не ври «играет».",
    },
    {
      // normalizeHost срезает www. → одна запись покрывает и www.youtube.com (отдельный дубль ЗАТЁР бы полный
      // хинт: оба host'а нормализуются в youtube.com, seed→seed перезапись безусловна — ревью AX-Ref #2).
      host: "youtube.com",
      hint:
        "YouTube: play/pause — по кнопке плеера (есть <video>, media-элемент = ground-truth состояния). Перемотка — seek " +
        "(seconds ±/to), НЕ back/forward. Поиск — поле сверху: type{text, enter:true}. Сверь исход по video.paused/currentTime.",
    },
  ];
  for (const s of SEED) store.upsert(s.host, s.hint, "seed");
}

/**
 * Персист: грузим data/site-recipes.json → навешиваем дебаунс-сохранение. Возвращает готовый стор (с seed).
 */
export function loadSiteRecipeStore(dir: string = dataDir()): SiteRecipeStore {
  const store = new SiteRecipeStore();
  const file = join(dir, FILE_NAME);
  try {
    if (existsSync(file)) {
      const rows = JSON.parse(readFileSync(file, "utf8")) as SiteRecipe[];
      if (Array.isArray(rows)) store.restore(rows);
    }
  } catch (e) {
    log.warn("не смог прочитать site-recipes.json — старт с пустого", { err: e instanceof Error ? e.message : String(e) });
  }
  seedSiteRecipes(store); // seed идемпотентен (upsert seed не перетирается learned'ом; seed→seed обновляет текст)
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(store.toJSON()), "utf8");
      renameSync(tmp, file);
    } catch (e) {
      log.warn("не смог сохранить site-recipes.json", { err: e instanceof Error ? e.message : String(e) });
    }
  };
  store.setOnChange(() => {
    if (timer) return;
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    if (typeof timer === "object" && "unref" in timer) (timer as { unref?: () => void }).unref?.();
  });
  return store;
}

// Процесс-синглтон для browser.ts (стор глобален по host — не нужен per-session DI). Ленивая инициализация:
// JARVIS_DATA_DIR читается в момент первого использования (в тестах перекрывается своим стором напрямую).
let singleton: SiteRecipeStore | null = null;
export function siteRecipes(): SiteRecipeStore {
  if (!singleton) singleton = loadSiteRecipeStore();
  return singleton;
}
