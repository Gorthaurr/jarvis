/**
 * Семантический кэш ОТВЕТОВ LLM (§15) — пропустить вызов модели, если на семантически близкий запрос
 * УЖЕ был дан чисто-вербальный ответ. Экономит дорогой ход на повторных фактических вопросах.
 *
 * 🔴 БЕЗОПАСНОСТЬ (Джарвис — агент с побочными эффектами, закон честности):
 *   1. Кэшируется ТОЛЬКО ход БЕЗ tool-use — чистый текст, никаких действий. Иначе реплей кэша соврал
 *      бы «готово», хотя в этот раз ничего не сделано. Гарантирует CALLER (store зовётся лишь на
 *      ходах с нулём инструментов).
 *   2. Кэшируются ТОЛЬКО контекст-НЕзависимые запросы (isCacheableQuery): без ты/мы/сейчас/это/времени/
 *      состояния — иначе тот же текст в другом контексте значит другое, а ответ протухает.
 *   3. Строгий порог косинуса (деф 0.92) — чтобы НЕ отдать ответ на ДРУГОЙ вопрос. Реальные эмбеддинги
 *      (e5) обязательны (на hash-мусоре было бы опасно — отключаем кэш на нерабочем эмбеддере → null).
 * Скоуп по userId (мультитенант: не отдаём ответ одного юзера другому). In-memory + TTL + кап размера.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import type { IEmbeddingProvider } from "../integrations/openai-embeddings.js";
import { looksLikeGiveUp } from "./agent/error-voice.js";

const log: Logger = createLogger("response-cache");

const SIM_MIN = (() => {
  const n = Number.parseFloat(process.env.JARVIS_RESPONSE_CACHE_MIN ?? "");
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.92;
})();
const TTL_MS = (() => {
  const n = Number.parseInt(process.env.JARVIS_RESPONSE_CACHE_TTL_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 6 * 3_600_000; // 6ч: факты стабильны, но не вечны
})();
const MAX_ENTRIES = 500;

// Контекст-зависимые / нестабильные маркеры → запрос НЕ кэшируем (значение зависит от контекста /
// ответ протухает). Токенизация, НЕ regex-\b: в JS \b на кириллице не работает (ASCII-\w). Денлист
// консервативен — лучше пропустить кэшируемое, чем отдать неверное.
// Точные слова (личное/дейксис/время):
const STOP_EXACT = new Set([
  "ты", "тебя", "тебе", "тобой", "твой", "твоя", "твоё", "твое", "твои",
  "вы", "вас", "вам", "ваш", "ваша", "ваше", "ваши",
  "мы", "нас", "нам", "наш", "наша", "наше", "наши",
  "я", "меня", "мне", "мной", "мой", "моя", "моё", "мое", "мои",
  "это", "этот", "эта", "эти", "этом", "этого", "этой", "тот", "там", "тут", "здесь",
  "сейчас", "сегодня", "вчера", "завтра", "сколько", "час", "часы",
]);
// Стемы (токен НАЧИНАЕТСЯ с) — состояние/живые данные, протухает:
const STOP_PREFIX = ["погод", "потрат", "врем", "баланс", "статус", "открыт", "запущен", "включ", "выключ", "напомн", "таймер"];
// Императивы-КОМАНДЫ (действие, не фактический вопрос). Кэш — ТОЛЬКО для Q&A; команду надо ВЫПОЛНЯТЬ
// каждый раз, а не отдавать заранее заготовленный ответ (главный корень «заевшей пластинки»: отказ
// «не могу» на команду кэшировался и крутился в обход петли агента). Блокировать кэш всегда безопасно —
// худшее — лишний промах; поэтому список широкий.
const COMMAND_PREFIX = [
  "перемот", "промот", "откро", "открой", "запуст", "постав", "переключ", "переведи", "перевед",
  "закро", "закрой", "найд", "сдела", "напиш", "отправ", "удал", "созда", "покаж", "пришл",
  "нажм", "кликн", "проигра", "сыгра", "останов", "пауз", "продолж", "скача", "загруз",
  "вруб", "выруб", "добав", "убер", "перейд", "сохран", "пиши", "ищи", "поищ", "купи", "закаж",
  "позвон", "набер", "перезвон", "поставь", "сверн", "разверн", "помен", "смен", "настрой",
];

/** Пригоден ли запрос для семантического кэша ответа? Чистая функция (юнит-тест). */
export function isCacheableQuery(text: string): boolean {
  const t = text.trim();
  if (t.length < 8) return false; // слишком коротко → команда/трёп, не фактический вопрос
  if (t.length > 300) return false; // длинная составная — почти всегда контекстная
  const tokens = t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const tok of tokens) {
    if (STOP_EXACT.has(tok)) return false;
    if (STOP_PREFIX.some((p) => tok.startsWith(p))) return false;
    if (COMMAND_PREFIX.some((p) => tok.startsWith(p))) return false;
  }
  return true;
}

interface Entry {
  vec: number[];
  answer: string;
  expiresAt: number;
}

export class SemanticResponseCache {
  private readonly byUser = new Map<string, Entry[]>();

  constructor(
    private readonly embedder: IEmbeddingProvider,
    private readonly now: () => number = Date.now,
  ) {}

  /** Поиск кэш-ответа на семантически близкий запрос. null — непригодно/нет эмбеддинга/промах. */
  async lookup(userId: string, query: string): Promise<string | null> {
    if (!isCacheableQuery(query)) return null;
    const vec = await this.embedder.embed(query, "query");
    if (!vec) return null; // нет реального эмбеддера → кэш молчит (безопаснее, чем матч по мусору)
    let best: Entry | null = null;
    let bestSim = 0;
    for (const e of this.prune(userId)) {
      const s = cosine(vec, e.vec);
      if (s > bestSim) {
        bestSim = s;
        best = e;
      }
    }
    if (best && bestSim >= SIM_MIN) {
      log.info("семантический кэш ответа: попадание", { sim: Number(bestSim.toFixed(3)) });
      return best.answer;
    }
    return null;
  }

  /** Сохранить чисто-вербальный ответ. CALLER гарантирует: ход без tool-use и без контекст-зависимости. */
  async store(userId: string, query: string, answer: string): Promise<void> {
    if (!isCacheableQuery(query) || !answer.trim()) return;
    // НИКОГДА не кэшируем отказ-капитуляцию: иначе «не могу» крутится по кругу в обход анти-капитуляции
    // (хит кэша возвращается ДО петли агента → ни нудж, ни эскалация на Opus не успевают). Отказ должен
    // КАЖДЫЙ раз проходить полную петлю (попробовать инструментами), а не отдаваться из кэша.
    if (looksLikeGiveUp(answer)) {
      log.info("кэш ответа: отказ не кэшируем (анти-«заевшая пластинка»)");
      return;
    }
    const vec = await this.embedder.embed(query, "query");
    if (!vec) return;
    const list = this.byUser.get(userId) ?? [];
    list.push({ vec, answer: answer.trim(), expiresAt: this.now() + TTL_MS });
    while (list.length > MAX_ENTRIES) list.shift(); // вытесняем старейшие
    this.byUser.set(userId, list);
  }

  /** Убрать протухшие записи юзера и вернуть живые. */
  private prune(userId: string): Entry[] {
    const now = this.now();
    const live = (this.byUser.get(userId) ?? []).filter((e) => e.expiresAt > now);
    this.byUser.set(userId, live);
    return live;
  }
}

/** Косинусная близость (e5-векторы уже нормализованы, но считаем честно — устойчиво к любому провайдеру). */
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
