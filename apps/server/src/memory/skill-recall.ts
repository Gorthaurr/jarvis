/**
 * RECALL/ДЕДУП выученных навыков (§8 HERMES) — вынесено из god-file skills.ts (§ревью).
 * Лексический матч (стемминг с длинозависимым префиксом) + семантический (косинус e5) + их дедуп-варианты
 * на сейве (порог строже recall). Чистые функции над RecalledSkill[] (без БД) — прямые юнит-тесты.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import type { IEmbeddingProvider } from "../integrations/openai-embeddings.js";
import { polarityConflict } from "./intent-polarity.js";
import type { RecalledSkill } from "./skills.js";

const log: Logger = createLogger("skill-recall");

/** Значимые токены (≥4 симв., ё→е) для лексического матча recall (§8). */
function skillTokens(s: string): string[] {
  const norm = s.toLowerCase().replace(/ё/g, "е");
  return (norm.match(/[a-zа-я0-9]+/gu) ?? []).filter((w) => w.length >= 4);
}

/** Длина общего префикса двух строк. */
function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Стемминг-матч с ДЛИНОЗАВИСИМЫМ порогом общего префикса (§8). Точное совпадение — всегда матч. Иначе нужен
 * общий префикс ≥ max(5, ⌈0.75·min(len)⌉): терпит русскую морфологию («отчёт»/«отчёта»), но НЕ ловит чужие
 * слова с коротким общим префиксом («почта»/«почти») — ложный recall вреднее пропуска.
 */
function tokenHit(q: ReadonlySet<string>, target: string): boolean {
  if (q.has(target)) return true;
  for (const w of q) {
    const need = Math.max(5, Math.ceil(0.75 * Math.min(w.length, target.length)));
    if (commonPrefixLen(w, target) >= need) return true;
  }
  return false;
}

/**
 * Порог релевантности recall навыка (§8). Env JARVIS_SKILL_RECALL_MIN (деф 0.34). Поднять → меньше ложных
 * инжектов навыка в промпт (экономия некешируемых токенов), но риск пропусков релевантного.
 */
const RECALL_MIN_SCORE = (() => {
  const n = Number.parseFloat(process.env.JARVIS_SKILL_RECALL_MIN ?? "");
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.34;
})();

/**
 * P2.3 НАДЁЖНОСТЬ: при стольких чистых провалах навык БОЛЬШЕ не подсовывается recall'ом — «учится на
 * ошибках», не повторяет провальный приём. Провал/успех копит/гасит agent-терминал (recordOutcome).
 * Env JARVIS_SKILL_FAIL_SUPPRESS (деф 3). Навык восстанавливается успехами (fail_count -1, не ниже 0).
 */
const SKILL_FAIL_SUPPRESS = (() => {
  const n = Number.parseInt(process.env.JARVIS_SKILL_FAIL_SUPPRESS ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : 3;
})();

/** Подавлен ли навык чередой провалов (P2.3) — не подсовывать его recall'ом. */
function isSuppressed(s: RecalledSkill): boolean {
  return (s.failCount ?? 0) >= SKILL_FAIL_SUPPRESS;
}

/**
 * §recall PLATFORM-BOOST (2026-07-14, живой тест сидов): e5-small взвешивает ДЕЙСТВИЕ выше ПЛАТФОРМЫ —
 * «отправить сообщение в дискорде» уходило к telegram-send (та же суть «отправить сообщение», платформа
 * терялась), а «лента в инстаграме» вообще не дотягивала до порога. Распознаём платформу/приложение в
 * ЗАПРОСЕ и в НАВЫКЕ по узнаваемому токену и корректируем косинус: та же платформа → буст (пробивает порог
 * и выигрывает), ЧУЖАЯ (навык называет ТОЛЬКО другую) → штраф. Навык БЕЗ платформы — нейтрален (общее
 * руководство остаётся годным). Токены сканируем по всему тексту БЕЗ фильтра ≥4 (skillTokens роняет «вк»/«тг»):
 * длинные распознаваемые стемы — по префиксу (дискорд→дискорде), короткие/неоднозначные — только точное
 * равенство (не ловим «вкусно» на «вк»).
 */
const PLATFORM_ALIASES: ReadonlyArray<readonly [string, { readonly prefix: readonly string[]; readonly exact: readonly string[] }]> = [
  ["discord", { prefix: ["дискорд", "discord"], exact: [] }],
  // telegram: exact-формы приложения, вкл. ЧАСТЫЕ разговорные с двумя «м» («телеграмм»/«телеграмме» — так
  //           мессенджер и пишут/произносят чаще всего). Оставлены ВНЕ списка только почтовые «телеграмма»/
  //           «телеграмму» (номинатив/аккузатив существительного «телеграмма») — их префикс ловил ложно (ревью).
  ["telegram", { prefix: [], exact: ["телеграм", "телеграме", "телеграмом", "телеграмм", "телеграмме", "телеграммом", "тг", "telegram"] }],
  ["vk", { prefix: ["вконтакт"], exact: ["вк", "vk"] }],
  ["instagram", { prefix: ["инстаграм", "instagram"], exact: ["инста", "инсте", "инсту", "insta"] }],
  ["youtube", { prefix: ["ютуб", "youtube", "ютьюб"], exact: [] }],
  // dota: exact-формы. Добавлены STT-вариант «доти» и слитный «dota2»; убрана «доты» (частый плюрал-омоним
  //       «доты второй мировой» = бункеры). Остальные формы (доте/доту) — омонимы склонений «дот», но у
  //       геймера значат Dota; ложный буст на не-игровом запросе гасит raw-cos-floor (низкий косинус к «найти матч»).
  ["dota", { prefix: [], exact: ["дота", "доте", "доту", "дотка", "дотку", "доти", "dota", "dota2"] }],
];

/** Слова текста (ё→е, любой длины — короткие платформенные токены не роняем). */
function textWords(s: string): string[] {
  return s.toLowerCase().replace(/ё/g, "е").match(/[a-zа-я0-9]+/gu) ?? [];
}

/** Платформы/приложения, упомянутые в тексте (по узнаваемому токену). Экспорт для юнит-теста. */
export function detectPlatforms(text: string): Set<string> {
  const words = textWords(text);
  const found = new Set<string>();
  for (const [plat, { prefix, exact }] of PLATFORM_ALIASES) {
    if (words.some((w) => exact.includes(w) || prefix.some((p) => w.startsWith(p)))) found.add(plat);
  }
  return found;
}

/** Отношение навыка к платформе запроса: match (та же), conflict (называет ТОЛЬКО чужую), neutral (без платформы). */
function platformRelation(qPlat: ReadonlySet<string>, skillText: string): "match" | "conflict" | "neutral" {
  if (qPlat.size === 0) return "neutral";
  const sPlat = detectPlatforms(skillText);
  if (sPlat.size === 0) return "neutral";
  for (const p of sPlat) if (qPlat.has(p)) return "match";
  return "conflict";
}

/** Насколько бустим косинус навыку той же платформы (env JARVIS_SKILL_PLATFORM_BOOST). Навык ЧУЖОЙ
 *  платформы не штрафуется, а вовсе не берётся в кандидаты (continue) — штраф перебивался лексикой (ревью). */
const PLATFORM_BOOST = (() => {
  const n = Number.parseFloat(process.env.JARVIS_SKILL_PLATFORM_BOOST ?? "");
  return Number.isFinite(n) && n >= 0 && n <= 0.5 ? n : 0.1;
})();
/** Вес лексического бонуса в гибридном ранге recall (env JARVIS_SKILL_LEXICAL_WEIGHT). e5-small шумный —
 *  distinctive-токены поднимают реально совпавший навык над семантическим шумом. */
const LEXICAL_WEIGHT = (() => {
  const n = Number.parseFloat(process.env.JARVIS_SKILL_LEXICAL_WEIGHT ?? "");
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.2;
})();
/**
 * Нижний порог СЫРОГО косинуса, ниже которого бонусы (лексика/платформа) НЕ применяются (env
 * JARVIS_SKILL_RAW_COS_FLOOR). Без него бонусы (до +0.3) проталкивали семантически ДАЛЁКИЙ навык через
 * порог 0.82 (эффективный порог падал до ~0.52) — ложный recall/неверный ТОП-1 (ревью 2026-07-14).
 * Буст лишь НУДЖИТ уже близкий навык (≥floor); навык ЧУЖОЙ платформы (conflict) в кандидаты не берётся
 * вовсе (continue), независимо от floor.
 */
const RAW_COS_FLOOR = (() => {
  const n = Number.parseFloat(process.env.JARVIS_SKILL_RAW_COS_FLOOR ?? "");
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.7;
})();

/**
 * Подобрать лучший выученный навык под текст задачи (§8 HERMES). Лексический матч с грубым стеммингом по
 * имени+описанию. Порог консервативный (≥2 попадания и ≥RECALL_MIN_SCORE): ложный recall вреднее пропуска.
 * Чистая функция (без БД) — для прямого юнит-теста.
 */
export function matchLearnedSkill(text: string, skills: readonly RecalledSkill[]): RecalledSkill | null {
  const q = new Set(skillTokens(text));
  if (q.size === 0) return null;
  const qPlat = detectPlatforms(text); // §platform-boost: чужую платформу не подсовываем и в лексике
  let best: RecalledSkill | null = null;
  let bestScore = 0;
  for (const s of skills) {
    if (isSuppressed(s)) continue; // P2.3: хронически падающий навык не подсовываем
    if (polarityConflict(text, `${s.name} ${s.when}`)) continue; // §8: «прекрати X» не получает навык «запусти X»
    if (qPlat.size > 0 && platformRelation(qPlat, `${s.name} ${s.when}`) === "conflict") continue; // §platform: чужая платформа
    const targets = [...new Set(skillTokens(`${s.name} ${s.when}`))];
    if (targets.length === 0) continue;
    let hits = 0;
    for (const t of targets) if (tokenHit(q, t)) hits += 1;
    const score = hits / Math.min(q.size, targets.length);
    // Тай-брейк детерминирован (по id), чтобы recall не зависел от порядка listSkills.
    if (hits >= 2 && (score > bestScore || (score === bestScore && best !== null && s.id < best.id))) {
      best = s;
      bestScore = score;
    }
  }
  return bestScore >= RECALL_MIN_SCORE ? best : null;
}

/** Порог дедупа на СЕЙВЕ — СТРОЖЕ recall-инжекта; настраивается JARVIS_SKILL_DEDUP_MIN. */
const DEDUP_MIN_SCORE = (() => {
  const n = Number.parseFloat(process.env.JARVIS_SKILL_DEDUP_MIN ?? "");
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.6;
})();

/**
 * Найти существующий навык, дублирующий (name+when) — для дедупа на СЕЙВЕ (§8). Тот же скоринг, что recall,
 * но ПОВЫШЕННЫЙ порог: склеить можно только реально тот же навык. Чистая функция — для юнит-теста.
 */
export function findDuplicateSkill(
  name: string,
  when: string,
  learned: readonly RecalledSkill[],
  minScore = DEDUP_MIN_SCORE,
): RecalledSkill | null {
  const q = new Set(skillTokens(`${name} ${when}`));
  if (q.size === 0) return null;
  let best: RecalledSkill | null = null;
  let bestScore = 0;
  for (const s of learned) {
    const targets = [...new Set(skillTokens(`${s.name} ${s.when}`))];
    if (targets.length === 0) continue;
    let hits = 0;
    for (const t of targets) if (tokenHit(q, t)) hits += 1;
    const score = hits / Math.min(q.size, targets.length);
    if (hits >= 2 && (score > bestScore || (score === bestScore && best !== null && s.id < best.id))) {
      best = s;
      bestScore = score;
    }
  }
  return bestScore >= minScore ? best : null;
}

/** Порог семантического recall навыка (косинус e5). Env JARVIS_SKILL_SEMANTIC_MIN. Не дотянул → лексика. */
const SKILL_SEMANTIC_MIN = (() => {
  const n = Number.parseFloat(process.env.JARVIS_SKILL_SEMANTIC_MIN ?? "");
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.82;
})();

/**
 * Кэш векторов триггеров навыков (ключ→{version,vec}) — не эмбеддить «name. when» каждый ход.
 * M8 (security): ключ композитный "ownerId:id", НЕ голый id — иначе приватные навыки двух юзеров
 * с одинаковым slug (тот же id, напр. "learned-open-notion") делят кэш-вектор через listSkillsMerged,
 * и recall одного тенанта мог отдать вектор чужого. ownerId берётся из самой записи (owner-scope).
 */
const triggerVecCache = new Map<string, { version: number; vec: number[] }>();

function triggerVecKey(s: RecalledSkill): string {
  return `${s.ownerId}:${s.id}`;
}

async function triggerVec(embedder: IEmbeddingProvider, s: RecalledSkill): Promise<number[] | null> {
  const key = triggerVecKey(s);
  const hit = triggerVecCache.get(key);
  if (hit && hit.version === s.version) return hit.vec;
  const vec = await embedder.embed(`${s.name}. ${s.when}`, "passage");
  if (vec) triggerVecCache.set(key, { version: s.version, vec });
  return vec;
}

function cosineSim(a: readonly number[], b: readonly number[]): number {
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

/**
 * Семантический recall навыка (§8): эмбеддинг запроса (e5 "query") против триггеров («name. when» "passage"),
 * косинус ≥ порога. Ловит падежи/синонимы/перефраз. Эмбеддер null / не уверен → ЛЕКСИЧЕСКИЙ фолбэк. Экспорт для теста.
 */
export async function recallSemantic(
  embedder: IEmbeddingProvider,
  text: string,
  learned: readonly RecalledSkill[],
): Promise<RecalledSkill | null> {
  const qv = await embedder.embed(text, "query");
  if (!qv) return matchLearnedSkill(text, learned);
  const qPlat = detectPlatforms(text); // §platform-boost: платформа(ы) в запросе
  const qTokens = new Set(skillTokens(text)); // §hybrid: значимые токены запроса для лексического бонуса
  let best: RecalledSkill | null = null;
  let bestSim = 0;
  let bestBoosted = false;
  // Гард полярности: близкий по косинусу, но противоположный по смыслу навык («прекрати X» ↔
  // «запусти X») не подсовываем ни в промпт, ни в авто-реплей. Заблокированного лучшего логируем —
  // иначе тихий пропуск не отличить от «навыка нет» при разборе логов.
  let blocked: RecalledSkill | null = null;
  let blockedSim = 0;
  for (const s of learned) {
    if (isSuppressed(s)) continue; // P2.3: хронически падающий навык не подсовываем (и в семантике)
    const tv = await triggerVec(embedder, s);
    if (!tv) continue;
    // §platform: чужая платформа (навык называет ТОЛЬКО другую) → навык НЕ кандидат вовсе — как
    // matchLearnedSkill (continue). Раньше был штраф −PENALTY, но лексический бонус (кап 0.2 > штраф 0.15)
    // его перебивал → wrong-platform навык всё равно проходил порог (ревью). Считаем rel ОДИН раз.
    const rel = qPlat.size > 0 ? platformRelation(qPlat, `${s.name} ${s.when}`) : "neutral";
    if (rel === "conflict") continue;
    const rawCos = cosineSim(qv, tv);
    let sim = rawCos;
    // Бусты (лексика + буст той же платформы) НУДЖАТ лишь уже близкий по семантике навык (rawCos ≥ floor),
    // иначе бы бонусы проталкивали далёкий навык через порог (ревью).
    const eligibleForBoost = rawCos >= RAW_COS_FLOOR;
    let boosted = false;
    if (eligibleForBoost) {
      // §hybrid (2026-07-14): e5-small ШУМНЫЙ — несвязанные навыки набирают 0.82+ (у порога). Лексический
      // бонус по РАЗЛИЧИТЕЛЬНЫМ общим токенам («дискорде»/«сообщение») поднимает реально совпавший навык над
      // семантическим шумом. Доля токенов навыка, попавших в запрос — КАПНУТА ≤1 (tokenHit по префиксу может
      // дать hits > знаменателя на морфо-вариантах, ревью → без Math.min бонус превышал бы LEXICAL_WEIGHT).
      const targets = [...new Set(skillTokens(`${s.name} ${s.when}`))];
      if (targets.length > 0 && qTokens.size > 0) {
        let hits = 0;
        for (const t of targets) if (tokenHit(qTokens, t)) hits += 1;
        sim += LEXICAL_WEIGHT * Math.min(1, hits / Math.min(qTokens.size, targets.length));
      }
      // §platform-boost: та же платформа — буст (выиграть у той же сути на чужой платформе).
      if (rel === "match") {
        sim += PLATFORM_BOOST;
        boosted = true;
      }
    }
    if (polarityConflict(text, `${s.name} ${s.when}`)) {
      if (sim > blockedSim) {
        blockedSim = sim;
        blocked = s;
      }
      continue;
    }
    if (sim > bestSim) {
      bestSim = sim;
      best = s;
      bestBoosted = boosted;
    }
  }
  if (blocked && blockedSim >= SKILL_SEMANTIC_MIN && bestSim < SKILL_SEMANTIC_MIN) {
    log.info("skill recall: подавлен гардом полярности (стоп-команда ↔ запускной навык)", {
      id: blocked.id,
      sim: Number(blockedSim.toFixed(3)),
    });
  }
  if (best && bestSim >= SKILL_SEMANTIC_MIN) {
    log.info("skill recall: семантическое попадание", { id: best.id, sim: Number(bestSim.toFixed(3)), platformBoost: bestBoosted || undefined });
    return best;
  }
  // Диагностика: лучший кандидат не дотянул до порога — видно, НАСКОЛЬКО (для тюнинга boost/порога).
  if (best) {
    log.info("skill recall: ниже порога семантики", {
      id: best.id,
      sim: Number(bestSim.toFixed(3)),
      threshold: SKILL_SEMANTIC_MIN,
      platform: qPlat.size ? [...qPlat].join(",") : undefined,
    });
  }
  return matchLearnedSkill(text, learned);
}

/** Порог СЕМАНТИЧЕСКОГО дедупа на сейве — СТРОЖЕ recall (склеиваем только реально один навык). */
const SKILL_DEDUP_SEMANTIC_MIN = (() => {
  const n = Number.parseFloat(process.env.JARVIS_SKILL_DEDUP_SEMANTIC_MIN ?? "");
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.9;
})();

/**
 * Семантический дедуп на сейве (§8): новый навык против триггеров существующих по косинусу e5, порог ВЫШЕ
 * recall — мёржим только реально тот же навык (лечит «дота/доте»). Эмбеддер null → строгий лексический. Экспорт для теста.
 */
export async function findDuplicateSemantic(
  embedder: IEmbeddingProvider,
  name: string,
  when: string,
  learned: readonly RecalledSkill[],
): Promise<RecalledSkill | null> {
  const qv = await embedder.embed(`${name}. ${when}`, "passage");
  if (!qv) return findDuplicateSkill(name, when, learned);
  let best: RecalledSkill | null = null;
  let bestSim = 0;
  for (const s of learned) {
    const tv = await triggerVec(embedder, s);
    if (!tv) continue;
    const sim = cosineSim(qv, tv);
    if (sim > bestSim) {
      bestSim = sim;
      best = s;
    }
  }
  if (best && bestSim >= SKILL_DEDUP_SEMANTIC_MIN) return best;
  return findDuplicateSkill(name, when, learned);
}
