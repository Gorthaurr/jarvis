/**
 * ВЫУЧЕННЫЕ РЕЦЕПТЫ ПРОГРАММНЫХ КАНАЛОВ: Джарвис сам записывает, чем управлять программой без кликов.
 *
 * Зачем отдельно от НАВЫКОВ (вопрос владельца 2026-09-01, различие принципиальное):
 * — навык — это «КАК Я ЭТО ДЕЛАЛ»: последовательность шагов, выученная из опыта/показа;
 * — рецепт — это «ЧТО С ЭТОЙ ПРОГРАММОЙ ВООБЩЕ ВОЗМОЖНО»: существование канала, его контракт и способ
 *   сверки исхода. Рецепт верен независимо от того, делал ли Джарвис это раньше.
 * Смешивать нельзя: рецепт уходит в промпт как ДОВЕРЕННОЕ утверждение о возможностях, поэтому цена
 * выдумки здесь выше. Выдуманный «API Discord для отправки от лица владельца» — это либо ложное
 * обещание владельцу, либо self-bot и ПЕРМАНЕНТНЫЙ бан аккаунта.
 *
 * ПОЭТОМУ ЗАПИСЬ — ТОЛЬКО ПО ФАКТУ. Рецепт не принимается на слово: хендлер САМ выполняет пробу
 * (`probe`), и запись происходит лишь при её успехе; вывод пробы сохраняется как провенанс. Это
 * механическая честность вместо доверия к заявлению модели — тот же принцип, что «инструмент не
 * возвращает ложный успех».
 *
 * Зеркалит `site-recipes.ts` по persist-паттерну (атомарно tmp→rename, дебаунс). ⚠️ АВТОМАТИЧЕСКОГО
 * self-heal тут НЕТ и обещать его нельзя (адверс-ревью 2026-09-01: demote/reinforce были мёртвым
 * кодом — их никто не звал, потому что рецепт не «рекуллится» механически, его читает модель).
 * Единственный сигнал провала — явный `app_channel_forget`; поле failCount оставлено как фильтр на
 * будущее, если появится автоматический источник исхода.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lazyDataPath } from "../paths.js";
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("app-recipes");
const FILE_NAME = "app-recipes.json";
const SAVE_DEBOUNCE_MS = 300;
const MAX_ENTRIES = 200;
/** Рецепт, проваленный ≥ этого числа раз подряд, больше НЕ предлагается (учится на ошибках). */
const FAIL_SUPPRESS = Number.parseInt(process.env.JARVIS_APP_RECIPE_FAIL_SUPPRESS ?? "", 10) || 2;

export interface LearnedRecipe {
  /** Нормализованный ключ приложения (lowercase, без версии). */
  app: string;
  /** Имя exe, если известно — по нему рецепт находит установленную программу. */
  exe?: string;
  kind: string;
  howTo: string;
  verify: string;
  limits: string;
  /** Чем ПОДТВЕРЖДЁН: команда пробы и то, что она реально вывела (усечённо). Не заявление модели. */
  provenance: string;
  failCount: number;
  updatedAt: number;
}

/** Ключ приложения: lowercase, без хвостовых версий и скобок («Cursor (User) 1.2» → «cursor»). */
export function normalizeApp(input: string): string {
  return String(input || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\bv?\d+(\.\d+)+\b/g, " ")
    .replace(/[^\p{L}\p{N}+.\- ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class AppRecipeStore {
  private map = new Map<string, LearnedRecipe>();
  private onChange?: () => void;
  constructor(
    entries: LearnedRecipe[] = [],
    private now: () => number = Date.now,
  ) {
    for (const e of entries) if (e?.app) this.map.set(e.app, e);
  }

  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  /** Все живые рецепты (подавленные провалами не отдаются). */
  list(): LearnedRecipe[] {
    return [...this.map.values()].filter((r) => r.failCount < FAIL_SUPPRESS);
  }

  get(app: string): LearnedRecipe | null {
    const r = this.map.get(normalizeApp(app));
    if (!r) return null;
    return r.failCount < FAIL_SUPPRESS ? r : null;
  }

  /** Записать/обновить. Вызывать ТОЛЬКО после успешной пробы (см. шапку модуля). */
  upsert(r: Omit<LearnedRecipe, "failCount" | "updatedAt" | "app"> & { app: string }): LearnedRecipe {
    const key = normalizeApp(r.app);
    const rec: LearnedRecipe = { ...r, app: key, failCount: 0, updatedAt: this.now() };
    this.map.set(key, rec);
    if (this.map.size > MAX_ENTRIES) {
      // Вытесняем самый старый — стор не растёт без предела.
      const oldest = [...this.map.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (oldest) this.map.delete(oldest.app);
    }
    this.onChange?.();
    return rec;
  }

  forget(app: string): boolean {
    const ok = this.map.delete(normalizeApp(app));
    if (ok) this.onChange?.();
    return ok;
  }

  toJSON(): LearnedRecipe[] {
    return [...this.map.values()];
  }
}

// ── персист (атомарно tmp→rename, дебаунс — зеркало site-recipes/resolution-memory) ──────────

let singleton: AppRecipeStore | null = null;
let saveTimer: NodeJS.Timeout | null = null;

/** Путь стора. lazyDataPath отдаёт ФУНКЦИЮ: путь считается при первом обращении, ПОСЛЕ загрузки .env
 *  (ESM хойстит импорты выше loadEnv — грабля проекта с мёртвым JARVIS_DATA_DIR). */
const filePath = lazyDataPath(FILE_NAME);

function scheduleSave(store: AppRecipeStore): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const file = filePath();
      mkdirSync(join(file, ".."), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(store.toJSON()), "utf8");
      renameSync(tmp, file);
    } catch (e) {
      log.warn("не удалось сохранить рецепты приложений", { err: e instanceof Error ? e.message : String(e) });
    }
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

export function appRecipes(): AppRecipeStore {
  if (singleton) return singleton;
  let entries: LearnedRecipe[] = [];
  try {
    const file = filePath();
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) entries = parsed as LearnedRecipe[];
    }
  } catch (e) {
    log.warn("рецепты приложений не прочитаны — начинаю с пустого стора", {
      err: e instanceof Error ? e.message : String(e),
    });
  }
  const store = new AppRecipeStore(entries);
  store.setOnChange(() => scheduleSave(store));
  singleton = store;
  log.info("рецепты приложений загружены", { count: entries.length });
  return store;
}

/** Для тестов: сбросить синглтон (каждый тест — свой стор). */
export function resetAppRecipesForTest(): void {
  singleton = null;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}
