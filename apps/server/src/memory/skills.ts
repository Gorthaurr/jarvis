/**
 * Навыки (SKILL.md) — хранилище и парсинг (§8).
 *
 * Канон навыка — это content_md (человекочитаемый Markdown с фронтматтером).
 * Производные steps (SkillStep[]) парсятся ИЗ content_md при сохранении и
 * кешируются — это derived-данные, источник истины всегда content_md.
 *
 * parseSkillMd — реальный базовый парсер (frontmatter + шаги). CRUD идёт через
 * pg; без БД операции no-op (stub), но parseSkillMd работает всегда.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillStep, Target, UiPattern } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { dataPath } from "../paths.js";
import { isDbReady, query } from "../db/pool.js";
import { extractSlots } from "./skill-slots.js";
import type { IEmbeddingProvider } from "../integrations/openai-embeddings.js";
import { findDuplicateSemantic, findDuplicateSkill, matchLearnedSkill, recallSemantic } from "./skill-recall.js";
import { attachReplaySection } from "./skill-macro.js";

// Recall/дедуп вынесены в skill-recall.ts (§ревью); ре-экспорт — обратная совместимость импортёров/тестов.
export { findDuplicateSemantic, findDuplicateSkill, matchLearnedSkill, recallSemantic };

const log: Logger = createLogger("skills");

/** Папка осязаемых SKILL.md на диске (§универсальность: JARVIS_DATA_DIR → иначе cwd/data). */
const SKILLS_DIR = dataPath("skills");

/**
 * Префикс id выученных навыков-процедур (§8 HERMES). Развязывает их пространство имён с
 * записанными показом реплей-навыками (тот же `slugify(name)` иначе схлопнул бы их в один
 * ряд таблицы и upsert затёр бы друг друга). `__` slugify НИКОГДА не порождает (любой
 * не-`[a-z0-9-]` → `-`), поэтому learned-id не может совпасть с demonstrated-id.
 */
const LEARNED_ID_PREFIX = "learned__";

/**
 * Псевдо-пользователь ОБЩЕЙ библиотеки навыков (мультитенант, Фаза 1). Навыки под этим userId видны
 * ВСЕМ (recall/list сливают `private ∪ shared`), но частный навык того же id ПЕРЕКРЫВАЕТ общий —
 * так «общие скилы под все компы» (TG/YouTube-процедуры и т.п.) не нужно учить каждому юзеру, а свой
 * вариант всегда главнее. Нулевой UUID ≠ DEV_USER (`…0001`) — отдельная партиция, не пересекается.
 */
export const SHARED_USER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Фолбэк-хранилище навыков на процесс, когда БД недоступна (DATABASE_URL пуст/недоступен).
 * Без него HERMES «учился бы в пустоту» в no-DB конфигурации: skill_save вернул бы ok, но
 * recall в следующей задаче ничего не нашёл. При наличии БД (query≠null) НЕ используется —
 * источник истины БД. Зеркалит подход эпизодической памяти (InMemory-фолбэк).
 */
const memSkills = new Map<string, SkillRecord>();
const memKey = (userId: string, id: string): string => `${userId}::${id}`;

/**
 * Кебаб-слаг из имени навыка (латиница/цифры; кириллица транслитерируется грубо, §8).
 * Единый источник для всех, кому нужен id навыка из человеко-имени (демо-запись и
 * самообучение HERMES) — чтобы повторное сохранение того же имени попадало в тот же id.
 */
export function slugify(name: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
    и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
    с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
    ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", " ": "-",
  };
  const slug = [...name.toLowerCase()]
    .map((ch) => (ch in map ? map[ch] : /[a-z0-9-]/.test(ch) ? ch : "-"))
    .join("")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "skill";
}

/**
 * Записать осязаемый SKILL.md на диск (data/skills/<id>.md, §8) — пользователь может
 * открыть и увидеть, что Джарвис запомнил. Не фатально: диск-сбой не валит сохранение
 * в БД (источник истины — content_md в skills).
 */
export async function writeSkillFile(id: string, contentMd: string): Promise<void> {
  try {
    await mkdir(SKILLS_DIR, { recursive: true });
    await writeFile(join(SKILLS_DIR, `${id}.md`), contentMd, "utf8");
    log.info(`SKILL.md записан: ${join(SKILLS_DIR, `${id}.md`)}`);
  } catch (e) {
    log.warn(`не удалось записать SKILL.md на диск: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── МУЛЬТИ-ДЕМО ДИСТИЛЛЯЦИЯ (идея BrowserBC: запись N показов одной capability → ОДИН обобщённый
//    устойчивый навык сильной моделью, вместо хрупкого «как сделал последний раз»). Закрывает TODO
//    «дистилляция процедуры». Демонстрации копятся per-(user,skill) рядом со SKILL.md; распознавание
//    «той же capability» — существующий семантический дедуп в save(). Исполнение/verify-loop не меняем. ──

const DEMOS_DIR = join(SKILLS_DIR, "_demos");

/** Одна сырая демонстрация: как пользователь сделал задачу один раз. */
export interface SkillDemonstration {
  when: string;
  procedure: string;
  ts?: number;
}

/** Дистиллятор: из нескольких демонстраций одной capability → ОДНА обобщённая процедура (LLM, сильный тир). */
export type SkillDistiller = (input: {
  name: string;
  when: string;
  demonstrations: readonly SkillDemonstration[];
}) => Promise<string | null>;

/** Прочитать накопленные демонстрации навыка (per-user). Нет файла/сбой → []. */
async function readDemos(userId: string, id: string): Promise<SkillDemonstration[]> {
  try {
    const arr = JSON.parse(await readFile(join(DEMOS_DIR, `${userId}__${id}.json`), "utf8"));
    return Array.isArray(arr) ? (arr as SkillDemonstration[]) : [];
  } catch {
    return [];
  }
}

/** Сохранить демонстрации навыка (per-user). Не фатально. */
async function writeDemos(userId: string, id: string, demos: readonly SkillDemonstration[]): Promise<void> {
  try {
    await mkdir(DEMOS_DIR, { recursive: true });
    await writeFile(join(DEMOS_DIR, `${userId}__${id}.json`), JSON.stringify(demos), "utf8");
  } catch (e) {
    log.warn(`не удалось сохранить демонстрации навыка: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Выбрать процедуру для сохранения (ЧИСТАЯ, distiller инъектируется → тестируема без сети):
 * при ≥2 демонстрациях И наличии дистиллятора — обобщённый дистиллят; иначе — свежая процедура.
 * Дистиллятор упал/вернул пусто → честный фолбэк на свежую (не теряем сохранение).
 */
export async function distillProcedure(
  name: string,
  when: string,
  demonstrations: readonly SkillDemonstration[],
  freshProcedure: string,
  distiller?: SkillDistiller,
): Promise<string> {
  if (distiller && demonstrations.length >= 2) {
    const d = await distiller({ name, when, demonstrations }).catch(() => null);
    if (d && d.trim()) return d.trim();
  }
  return freshProcedure.trim();
}

/** Распарсенный SKILL.md. */
export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  steps: SkillStep[];
}

/** Фронтматтер навыка (YAML-подобный, базовые поля). */
export interface SkillFrontmatter {
  id?: string;
  name?: string;
  version?: number;
  /** Шаги, помеченные protected, не правит автоконсолидация (§8). */
  [key: string]: unknown;
}

/** Полная запись навыка. */
export interface SkillRecord {
  id: string;
  userId: string;
  version: number;
  /** Источник истины. */
  contentMd: string;
  /** Производные шаги (derived при сохранении). */
  steps: SkillStep[];
  failCount: number;
  updatedAt: number;
}

// ── парсинг ──────────────────────────────────────────────────

/**
 * Базовый парсер SKILL.md (§8).
 *
 * Формат:
 *   ---
 *   id: open-notion
 *   name: Открыть Notion
 *   version: 2
 *   ---
 *   ## Шаги
 *   1. launch app="Notion"
 *   2. ui.invoke role="button" name="New page" pattern="invoke"
 *   3. input.type text="Заметка"
 *
 * Каждый шаг: <action> [key="value" ...]. Известные ключи мапятся в Target/params.
 * Неизвестные действия сохраняются как action со своими params (forward-совместимо).
 */
export function parseSkillMd(content: string): ParsedSkill {
  const { frontmatter, body } = splitFrontmatter(content);
  const steps: SkillStep[] = [];

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    // Шаг — строка вида "1. action ..." или "- action ..." или просто "action ...".
    const m = /^(?:\d+\.|[-*])?\s*([a-z][\w.]*)\s*(.*)$/iu.exec(line);
    if (!m) continue;
    const action = m[1]!;
    // Пропускаем заголовки/прозу: шагом считаем только известные глаголы/kind'ы.
    if (!isStepAction(action)) continue;

    const kv = parseKeyValues(m[2] ?? "");
    steps.push(buildStep(action, kv));
  }

  return { frontmatter, steps };
}

/** Список распознаваемых действий шага (ActionKind + верхнеуровневые интенты, §6). */
const STEP_ACTIONS: ReadonlySet<string> = new Set([
  "input.type",
  "input.key",
  "input.click",
  "ui.invoke",
  "ui.ground",
  "app.launch",
  "launch",
  "app.focus",
  "focus",
  "browser.open",
  "browser.act",
  "browser.read",
  "code.run",
  "screen.capture",
  "context.read",
  "message.send",
  "order.place",
  "confirm",
  "ground",
  "verify",
  "wait",
]);

function isStepAction(action: string): boolean {
  return STEP_ACTIONS.has(action.toLowerCase());
}

/** Собрать SkillStep из действия и пар ключ-значение. */
function buildStep(action: string, kv: Record<string, string>): SkillStep {
  const step: SkillStep = { action: canonicalAction(action) };

  const target = buildTarget(kv);
  if (target) step.target = target;

  // Служебные ключи, которые не уходят в params (target/expect/мета).
  const RESERVED = new Set([
    "role", "name", "handle", "x", "y", "by", "space",
    "expectrole", "expectname", "expectstate", "needsllm", "timeoutms", "retries",
  ]);

  // params — всё, что не ушло в target/служебные поля.
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(kv)) {
    if (RESERVED.has(k.toLowerCase())) continue;
    if (k === "pattern" || k === "value" || k === "text" || k === "combo" || k === "app" || k === "url") {
      params[k] = v;
    } else {
      params[k] = v;
    }
  }
  if (kv.timeoutMs) {
    const n = Number.parseInt(kv.timeoutMs, 10);
    if (!Number.isNaN(n)) step.timeoutMs = n;
  }
  if (kv.retries) {
    const n = Number.parseInt(kv.retries, 10);
    if (!Number.isNaN(n)) step.retries = n;
  }
  if (kv.needsLlm === "true") step.needsLlm = true;
  if (kv.pattern) params.pattern = kv.pattern as UiPattern;
  if (Object.keys(params).length > 0) step.params = params;

  // expect — постусловие (auto-wait, §6): expectRole/expectName/expectState.
  const expect: NonNullable<SkillStep["expect"]> = {};
  if (kv.expectRole) expect.role = kv.expectRole;
  if (kv.expectName) expect.name = kv.expectName;
  if (kv.expectState) expect.state = kv.expectState;
  if (Object.keys(expect).length > 0) step.expect = expect;

  return step;
}

function buildTarget(kv: Record<string, string>): Target | undefined {
  if (kv.handle) return { by: "handle", handle: kv.handle };
  if (kv.role) return { by: "role", role: kv.role, ...(kv.name ? { name: kv.name } : {}) };
  if (kv.x && kv.y) {
    const x = Number.parseFloat(kv.x);
    const y = Number.parseFloat(kv.y);
    // space="screen" (§8 реплей-макрос): АБСОЛЮТНЫЕ экранные DIP — клиент не применяет маппинг скрина.
    if (!Number.isNaN(x) && !Number.isNaN(y)) return { by: "coords", x, y, ...(kv.space === "screen" ? { space: "screen" as const } : {}) };
  }
  return undefined;
}

/** Привести синонимы действий к каноническому виду. */
function canonicalAction(action: string): string {
  const a = action.toLowerCase();
  if (a === "launch") return "app.launch";
  if (a === "focus") return "app.focus";
  return a;
}

/** Снять экранирование serializeStep (обратное escapeAttr). Порядок обратный. */
function unescapeAttr(v: string): string {
  return v.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** Разобрать key="value" key2='v2' key3=v3 → словарь. */
function parseKeyValues(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w.]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const key = m[1]!;
    out[key] = unescapeAttr(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** Отделить YAML-фронтматтер (между --- ... ---) от тела. */
function splitFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const fm: SkillFrontmatter = {};
  const match = /^\s*---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/u.exec(content);
  if (!match) return { frontmatter: fm, body: content };

  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([\w-]+)\s*:\s*(.*)$/u.exec(line.trim());
    if (!kv) continue;
    const key = kv[1]!;
    const raw = (kv[2] ?? "").trim();
    fm[key] = key === "version" ? Number.parseInt(raw, 10) || raw : raw;
  }
  return { frontmatter: fm, body: match[2] ?? "" };
}

// ── CRUD (pg; no-op без БД) ──────────────────────────────────

/** Сохранить навык: пересчитать steps из content_md и записать (§8). */
export async function saveSkill(
  userId: string,
  contentMd: string,
): Promise<SkillRecord | null> {
  const parsed = parseSkillMd(contentMd);
  const id = String(parsed.frontmatter.id ?? "");
  const version = Number(parsed.frontmatter.version ?? 1);
  if (!id) {
    log.warn("saveSkill: в фронтматтере нет id — пропуск");
    return null;
  }

  const record: SkillRecord = {
    id,
    userId,
    version,
    contentMd,
    steps: parsed.steps,
    failCount: 0,
    updatedAt: Date.now(),
  };

  const res = await query(
    `insert into skills (id, user_id, version, content_md, steps, fail_count, updated_at)
     values ($1, $2, $3, $4, $5, 0, now())
     on conflict (id, user_id) do update
       set version = excluded.version,
           content_md = excluded.content_md,
           steps = excluded.steps,
           updated_at = now()`,
    [id, userId, version, contentMd, JSON.stringify(parsed.steps)],
  );
  if (!res) {
    // query() даёт null И при отсутствии БД, И при ОШИБКЕ запроса. Держим в памяти процесса
    // (фолбэк, чтобы recall в этой сессии нашёл навык), но различаем причину:
    memSkills.set(memKey(userId, id), record);
    if (await isDbReady()) {
      // БД ЕСТЬ, но запрос упал → навык НЕ персистён, после рестарта пропадёт. Это потеря
      // выученного — кричим (warn), а не молчим (debug), чтобы было видно в логах.
      log.warn("saveSkill: БД доступна, но запись упала — навык только в памяти (потеряется при рестарте)", { id });
    } else {
      log.debug("saveSkill: БД нет — навык сохранён в памяти процесса (фолбэк)");
    }
  }
  return record;
}

/** Прочитать навык по id (null если БД недоступна/не найден). */
export async function getSkill(userId: string, id: string): Promise<SkillRecord | null> {
  const res = await query(
    `select id, user_id, version, content_md, steps, fail_count,
            extract(epoch from updated_at) * 1000 as updated_at
       from skills where user_id = $1 and id = $2`,
    [userId, id],
  );
  if (!res) return memSkills.get(memKey(userId, id)) ?? null; // нет БД → фолбэк из памяти
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    version: Number(row.version),
    contentMd: String(row.content_md),
    steps: (row.steps as SkillStep[]) ?? [],
    failCount: Number(row.fail_count),
    updatedAt: Number(row.updated_at),
  };
}

/** Список всех навыков пользователя (для проброса в UI на старте сессии, §8). */
export async function listSkills(userId: string): Promise<SkillRecord[]> {
  const res = await query(
    `select id, user_id, version, content_md, steps, fail_count,
            extract(epoch from updated_at) * 1000 as updated_at
       from skills where user_id = $1 order by updated_at desc`,
    [userId],
  );
  if (!res) {
    // Нет БД → фолбэк из памяти процесса (порядок как в БД: свежие первыми).
    return [...memSkills.values()].filter((r) => r.userId === userId).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return res.rows.map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    version: Number(row.version),
    contentMd: String(row.content_md),
    steps: (row.steps as SkillStep[]) ?? [],
    failCount: Number(row.fail_count),
    updatedAt: Number(row.updated_at),
  }));
}

/** Удалить навык. Возвращает true, если запрос ушёл в БД. ОБЩИЙ навык так НЕ удаляется (его
 *  user_id = SHARED_USER_ID ≠ userId юзера) — безопасно по построению, отдельный гард не нужен. */
export async function deleteSkill(userId: string, id: string): Promise<boolean> {
  const res = await query(`delete from skills where user_id = $1 and id = $2`, [userId, id]);
  return res !== null;
}

/**
 * P2.3 НАДЁЖНОСТЬ: скорректировать счётчик провалов навыка. delta=+1 на провал задачи, где навык
 * применялся; delta=-1 (не ниже 0) на успех — надёжный навык «восстанавливается», хронически падающий
 * копит провалы и перестаёт подсовываться recall'ом (SKILL_FAIL_SUPPRESS). Нет БД → mem-фолбэк.
 */
export async function adjustSkillFailCount(userId: string, id: string, delta: number): Promise<void> {
  const res = await query(
    `update skills set fail_count = greatest(fail_count + $3, 0) where user_id = $1 and id = $2`,
    [userId, id, delta],
  );
  if (!res) {
    const rec = memSkills.get(memKey(userId, id)); // нет БД/запрос упал → фолбэк в памяти процесса
    if (rec) rec.failCount = Math.max(0, rec.failCount + delta);
  }
}

/**
 * Навыки юзера + ОБЩИЕ (shared) одним списком, с дедупом по id: ЧАСТНЫЙ навык перекрывает общий
 * того же id (улучшённый/свой вариант главнее). Используется agent-facing путями (recall/list/
 * каталог/execute) — НЕ дедупом на сейве (тот смотрит только свои, чтобы не мёржить в общий id).
 */
export async function listSkillsMerged(userId: string): Promise<SkillRecord[]> {
  if (userId === SHARED_USER_ID) return listSkills(SHARED_USER_ID); // сам общий — только его записи
  const [own, shared] = await Promise.all([listSkills(userId), listSkills(SHARED_USER_ID)]);
  const byId = new Map<string, SkillRecord>();
  for (const r of shared) byId.set(r.id, r); // сперва общие…
  for (const r of own) byId.set(r.id, r); // …затем свои перекрывают по id
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Навык по id из СВОИХ, иначе из ОБЩИХ (частный перекрывает общий). Для skill_execute/резолва. */
export async function getSkillMerged(userId: string, id: string): Promise<SkillRecord | null> {
  const own = await getSkill(userId, id);
  if (own || userId === SHARED_USER_ID) return own;
  return getSkill(SHARED_USER_ID, id);
}

/**
 * Идемпотентно залить курируемый стартовый набор в ОБЩУЮ библиотеку (Фаза 1, boot-seed). Каждый
 * элемент — канонический content_md (как `serializeLearnedSkill`). Перезаписываем ТОЛЬКО если в общей
 * библиотеке нет навыка с этим id ИЛИ сид-версия НОВЕЕ (не затираем то, что мог улучшить promote).
 * Возвращает число записанных. Сбой отдельного навыка не валит остальные (best-effort).
 */
export async function seedSharedSkills(mdContents: readonly string[]): Promise<number> {
  let written = 0;
  for (const md of mdContents) {
    try {
      const { frontmatter } = parseSkillMd(md);
      const id = String(frontmatter.id ?? "");
      const seedVer = Number(frontmatter.version ?? 1);
      if (!id) continue;
      const existing = await getSkill(SHARED_USER_ID, id);
      if (existing && existing.version >= seedVer) continue; // в общей уже свежее — не трогаем
      if (await saveSkill(SHARED_USER_ID, md)) {
        await writeSkillFile(id, md);
        written += 1;
      }
    } catch (e) {
      log.warn("seedSharedSkills: пропуск навыка", e instanceof Error ? e.message : String(e));
    }
  }
  if (written > 0) log.info(`общая библиотека навыков: засеяно ${written}`);
  return written;
}

// ── Провайдер навыков для agent-loop (§8): каталог + резолв для skill_execute ──

/** Краткая карточка навыка для каталога модели (skill_list). */
export interface SkillInfo {
  id: string;
  name: string;
  version: number;
  /** Есть guard-шаги (message.send/order.place/code.run/confirm) → нужно подтверждение (§14). */
  needsReview: boolean;
  /** Имена переменных {{slot}}, которые надо передать в params при skill_execute (§8). Пусто/нет — навык литеральный. */
  slots?: string[];
}

/** Резолвнутый навык для исполнения (skill_execute → ActionCommand skill.execute). */
export interface ResolvedSkill {
  id: string;
  version: number;
  steps: SkillStep[];
  needsReview: boolean;
}

/** Вход для сохранения выученного навыка-процедуры (HERMES, §8). */
export interface LearnedSkillInput {
  /** Короткое человеко-имя навыка (из него детерминируется id-слаг). */
  name: string;
  /** Когда применять (по какому запросу/ситуации). Хранится как description. */
  when: string;
  /** Markdown-процедура: шаги + грабли + проверка. Тело SKILL.md, которому LLM СЛЕДУЕТ. */
  procedure: string;
}

/** Итог сохранения выученного навыка. */
export interface SavedLearnedSkill {
  id: string;
  name: string;
  version: number;
}

/**
 * Выученный навык-процедура, поднятый recall'ом (§8 HERMES). В отличие от записанного
 * показом реплей-навыка (ResolvedSkill со steps) — это ТЕКСТ-руководство: его процедура
 * вшивается в системный промпт, и LLM ей СЛЕДУЕТ (гибко), а не реплеит детерминированно.
 */
export interface RecalledSkill {
  id: string;
  name: string;
  /** Когда применять (frontmatter description). */
  when: string;
  /** Тело процедуры (markdown после фронтматтера). */
  procedure: string;
  version: number;
  /** Навык из ОБЩЕЙ библиотеки (shared), а не личный — для честной формулировки в промпте (§мультитенант). */
  fromShared?: boolean;
  /** P2.3 НАДЁЖНОСТЬ: счётчик чистых провалов задач с этим навыком. recall перестаёт подсовывать навык
   *  при fail_count ≥ порога (см. SKILL_FAIL_SUPPRESS) — «учится на ошибках», не повторяет провальный приём. */
  failCount?: number;
  /** §8 МАКРОС: машинные шаги из секции «## Шаги (реплей)» (derived parseSkillMd). Есть ≥2 —
   *  агент сперва гонит детерминированный реплей ($0, секунды), LLM остаётся сверка глазами. */
  steps?: SkillStep[];
  /** Guard-шаги (send/order/code/confirm) в реплее → авто-прогон запрещён (§14). */
  needsReview?: boolean;
}

/** Итог попытки поднять навык в общую библиотеку (skill_promote, §мультитенант). */
export interface PromoteResult {
  ok: boolean;
  /** Имя навыка при успехе. */
  name?: string;
  /** Причина отказа: not_found | not_learned | already_shared | save_failed. */
  reason?: "not_found" | "not_learned" | "already_shared" | "save_failed";
}

export interface SkillProvider {
  /** Каталог РЕПЛЕЙ-навыков (записанных показом) для skill_list/skill_execute (§8). Свои + общие. */
  list(userId: string): Promise<SkillInfo[]>;
  /** Резолв реплей-навыка по id для skill_execute (§8). Выученные-процедуры сюда не входят. */
  get(userId: string, id: string): Promise<ResolvedSkill | null>;
  /** Сохранить выученный навык-процедуру (§8 HERMES, инструмент skill_save). */
  save(userId: string, input: LearnedSkillInput): Promise<SavedLearnedSkill | null>;
  /** Подобрать подходящий выученный навык под текст задачи (recall, §8). null — нет. Свои + общие. */
  recall(userId: string, text: string): Promise<RecalledSkill | null>;
  /** Поднять СВОЙ выученный навык в ОБЩУЮ библиотеку (§мультитенант): копия под SHARED_USER_ID.
   *  Опционально (как learnedCatalog) — тест-моки могут не реализовывать; dispatch гардит наличие. */
  promote?(userId: string, id: string): Promise<PromoteResult>;
  /** Компактный каталог ВЫУЧЕННЫХ навыков (имя+когда) — для семантического self-recall Claude'ом
   *  на лексическом промахе (выученные процедуры в skill_list НЕ входят). §8 Фаза 3. */
  learnedCatalog?(userId: string): Promise<Array<{ name: string; when: string }>>;
  /** P2.3 НАДЁЖНОСТЬ: записать исход задачи, где применялся выученный навык. success=false → +1 провал
   *  (навык приближается к подавлению в recall), success=true → -1 (восстановление). Опц. (моки могут не иметь). */
  recordOutcome?(userId: string, id: string, success: boolean): Promise<void>;
  /** §8 МАКРОС: вписать в СВОЙ выученный навык секцию авто-реплея (машинные строки шагов из
   *  успешного прогона). true — записано (версия++); false — нет изменений/не свой/не learned. */
  attachReplay?(userId: string, id: string, lines: readonly string[]): Promise<boolean>;
}

/**
 * Компактный каталог выученных навыков для контекста (§8 Фаза 3): по строке «• имя — когда».
 * Инжектится в НЕкешируемый хвост ТОЛЬКО при лексическом промахе (recall===null), капается —
 * чтобы Claude сам применил подходящий навык ПО СМЫСЛУ (падежи/синонимы/Герман↔Herman), без
 * эмбеддингов (у Claude их нет) и без токен-блоата каждый ход. Чистая функция — юнит-тест.
 */
export function formatSkillCatalog(skills: ReadonlyArray<{ name: string; when: string }>, cap = 10): string {
  const items = skills
    .slice(0, cap)
    .map((s) => `• ${String(s.name).trim()} — ${String(s.when).replace(/\s+/g, " ").trim().slice(0, 100)}`)
    .filter((l) => l.length > 4);
  return items.join("\n");
}

/** Это выученный навык-процедура (HERMES, source: learned), а не реплей записанного показом? */
export function isLearnedMd(contentMd: string): boolean {
  return String(parseSkillMd(contentMd).frontmatter.source ?? "").toLowerCase() === "learned";
}

/** Извлечь выученный навык из записи (null, если это реплей-навык, не процедура). */
function readLearned(rec: SkillRecord): RecalledSkill | null {
  const fm = parseSkillMd(rec.contentMd).frontmatter;
  if (String(fm.source ?? "").toLowerCase() !== "learned") return null;
  return {
    id: rec.id,
    name: String(fm.name ?? rec.id),
    when: String(fm.description ?? ""),
    procedure: splitFrontmatter(rec.contentMd).body.trim(),
    version: rec.version,
    failCount: rec.failCount, // P2.3: надёжность — recall подавит хронически падающий навык
    ...(rec.userId === SHARED_USER_ID ? { fromShared: true } : {}),
    // §8 МАКРОС: derived-шаги (проза не парсится; ≠[] только если в навыке есть машинная секция реплея).
    ...(rec.steps.length > 0 ? { steps: rec.steps, needsReview: hasGuardSteps(rec.steps) } : {}),
  };
}

/** Сериализовать выученный навык-процедуру в канонический content_md (§8 HERMES). */
export function serializeLearnedSkill(input: {
  id: string;
  name: string;
  version: number;
  when: string;
  procedure: string;
}): string {
  // Фронтматтер построчный → name/description должны быть одной строкой.
  const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
  const fm = [
    `id: ${input.id}`,
    `name: ${oneLine(input.name)}`,
    `version: ${input.version}`,
    `source: learned`,
    `description: ${oneLine(input.when)}`,
  ].join("\n");
  return `---\n${fm}\n---\n\n${input.procedure.trim()}\n`;
}

/** Человекочитаемое имя навыка из фронтматтера (иначе — id). */
function skillName(rec: SkillRecord): string {
  return String(parseSkillMd(rec.contentMd).frontmatter.name ?? rec.id);
}

/** Адаптер над listSkills/getSkill: каталог и резолв навыков для мозга (§8).
 *  embedder (опц.) включает СЕМАНТИЧЕСКИЙ recall; без него — лексический (как раньше). */
export function createSkillProvider(embedder?: IEmbeddingProvider, distiller?: SkillDistiller): SkillProvider {
  return {
    async list(userId) {
      const recs = await listSkillsMerged(userId); // свои + общие (частный перекрывает общий)
      // Выученные-процедуры (HERMES) не реплеятся — их место в recall, а не в skill_execute.
      return recs
        .filter((r) => !isLearnedMd(r.contentMd))
        .map((r) => {
          const slots = extractSlots(r.steps);
          return {
            id: r.id,
            name: skillName(r),
            version: r.version,
            needsReview: hasGuardSteps(r.steps),
            ...(slots.length > 0 ? { slots } : {}),
          };
        });
    },
    async get(userId, id) {
      const r = await getSkillMerged(userId, id); // свой, иначе общий
      if (!r || isLearnedMd(r.contentMd)) return null; // процедуру нельзя реплеить — только следовать
      return { id: r.id, version: r.version, steps: r.steps, needsReview: hasGuardSteps(r.steps) };
    },
    async save(userId, input) {
      const name = input.name.trim();
      if (!name || !input.procedure.trim()) {
        log.warn("skill save: пустое имя или процедура — пропуск");
        return null;
      }
      // Пространство id выученных навыков изолировано от записанных показом (см. LEARNED_ID_PREFIX).
      const slugId = LEARNED_ID_PREFIX + slugify(name);
      // ДЕДУП (§8): не плодить дубли на вариации ИМЕНИ (дота/доте/лишнее слово раньше → 3 строки).
      // Сначала точный slug, иначе семантически-похожий существующий learned-навык (скоринг как recall,
      // но СТРОЖЕ) → пишем в ЕГО id (upsert обновит версию); новый id только если похожего нет.
      const learned = (await listSkills(userId)).map(readLearned).filter((x): x is RecalledSkill => x !== null);
      const dup =
        learned.find((s) => s.id === slugId) ??
        (embedder ? await findDuplicateSemantic(embedder, name, input.when, learned) : findDuplicateSkill(name, input.when, learned));
      const id = dup ? dup.id : slugId;
      if (dup && dup.id !== slugId) log.info("skill save: дедуп — обновляю похожий навык", { id, insteadOf: slugId });
      // Повторное сохранение того же навыка — новая версия (улучшение, §8): version++.
      const existing = await getSkill(userId, id);
      const version = existing ? existing.version + 1 : 1;
      // МУЛЬТИ-ДЕМО ДИСТИЛЛЯЦИЯ (BrowserBC): копим показы одной capability → дистиллируем в ОДНУ
      // обобщённую устойчивую процедуру (вместо «как сделал последний раз»). Без дистиллятора/при 1 показе — свежая.
      const demos = await readDemos(userId, id);
      demos.push({ when: input.when, procedure: input.procedure.trim(), ts: Date.now() });
      const procedure = await distillProcedure(name, input.when, demos, input.procedure, distiller);
      if (procedure !== input.procedure.trim()) log.info("skill save: навык дистиллирован из демонстраций", { id, demos: demos.length });
      await writeDemos(userId, id, demos);
      const contentMd = serializeLearnedSkill({ id, name, version, when: input.when, procedure });
      const rec = await saveSkill(userId, contentMd);
      await writeSkillFile(id, contentMd);
      return { id, name, version: rec?.version ?? version };
    },
    async recall(userId, text) {
      const recs = await listSkillsMerged(userId); // свои + общие (частный перекрывает общий)
      const learned = recs
        .map(readLearned)
        .filter((x): x is RecalledSkill => x !== null);
      if (learned.length === 0) return null;
      // Семантический авто-инжект (эмбеддер e5): ловит падежи/синонимы/перефраз. Эмбеддер не передан /
      // вернул null → лексический matchLearnedSkill (как раньше). learnedCatalog (self-recall Claude'ом
      // по каталогу) остаётся бэкстопом на промахах обоих.
      if (embedder) return recallSemantic(embedder, text, learned);
      return matchLearnedSkill(text, learned);
    },
    async learnedCatalog(userId) {
      const recs = await listSkillsMerged(userId); // свои + общие
      return recs
        .map(readLearned)
        .filter((x): x is RecalledSkill => x !== null)
        .map((s) => ({ name: s.name, when: s.when }));
    },
    async recordOutcome(userId, id, success) {
      // P2.3: успех гасит провалы (-1, не ниже 0), провал копит (+1). Подавление в recall — по порогу.
      await adjustSkillFailCount(userId, id, success ? -1 : 1);
    },
    async promote(userId, id) {
      // Поднять можно ТОЛЬКО свой навык (owner-check через приватный getSkill, не merged).
      if (userId === SHARED_USER_ID) return { ok: false, reason: "already_shared" };
      const rec = await getSkill(userId, id);
      if (!rec) return { ok: false, reason: "not_found" };
      // В общую библиотеку поднимаем выученные ПРОЦЕДУРЫ (HERMES), не записанные показом реплеи.
      if (!isLearnedMd(rec.contentMd)) return { ok: false, reason: "not_learned" };
      const shared = await saveSkill(SHARED_USER_ID, rec.contentMd);
      if (!shared) return { ok: false, reason: "save_failed" };
      await writeSkillFile(rec.id, rec.contentMd);
      log.info("skill promote: навык поднят в общую библиотеку", { id });
      return { ok: true, name: skillName(rec) };
    },
    async attachReplay(userId, id, lines) {
      // §8 МАКРОС: только СВОЙ выученный навык (owner-write; координаты экрана — личные, не shared).
      const rec = await getSkill(userId, id);
      if (!rec || !isLearnedMd(rec.contentMd) || lines.length === 0) return false;
      const fm = parseSkillMd(rec.contentMd).frontmatter;
      const body = splitFrontmatter(rec.contentMd).body.trim();
      const newBody = attachReplaySection(body, lines);
      if (newBody === body) return false; // тот же реплей уже вписан — не бампаем версию
      const contentMd = serializeLearnedSkill({
        id,
        name: String(fm.name ?? id),
        version: rec.version + 1,
        when: String(fm.description ?? ""),
        procedure: newBody,
      });
      const saved = await saveSkill(userId, contentMd);
      if (!saved) return false;
      await writeSkillFile(id, contentMd);
      log.info("§8 макрос: авто-реплей вписан в навык", { id, version: saved.version, steps: lines.length });
      return true;
    },
  };
}

// ── guard-шаги и сериализация (§8) ───────────────────────────

/** Действия-гарды, которые автоконсолидация НЕ правит (§8, правило 1). */
const GUARD_ACTIONS: ReadonlySet<string> = new Set([
  "message.send",
  "order.place",
  "code.run",
  "confirm",
]);

/**
 * Guard-шаг (§8): необратимое/подтверждаемое действие. Консолидация не трогает,
 * свежевыученный скилл с такими шагами требует ревью перед первым применением (§14).
 */
export function isGuardStep(step: SkillStep): boolean {
  const a = step.action.toLowerCase();
  if (GUARD_ACTIONS.has(a)) return true;
  // powershell — всегда guard (§6).
  if (a === "code.run" && (step.params?.lang as string | undefined)?.toLowerCase() === "powershell") {
    return true;
  }
  return false;
}

/** Содержит ли скилл guard-шаги (нужно ревью §14). */
export function hasGuardSteps(steps: readonly SkillStep[]): boolean {
  return steps.some(isGuardStep);
}

/**
 * Экранирование значения внутри key="value" (§8): кавычка в значении (частый случай —
 * имя кнопки/текст с «"») иначе вырвалась бы из литерала и поломала парсинг остатка
 * строки в новые «ключи». Обратимо unescapeAttr в parseKeyValues.
 */
function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Сериализовать шаг обратно в строку SKILL.md (обратимо к parseSkillMd). */
export function serializeStep(step: SkillStep, index: number): string {
  const toks: string[] = [step.action];
  const t = step.target;
  if (t) {
    if (t.by === "role") {
      toks.push(`role="${escapeAttr(t.role)}"`);
      if (t.name) toks.push(`name="${escapeAttr(t.name)}"`);
    } else if (t.by === "handle") {
      toks.push(`handle="${escapeAttr(t.handle)}"`);
    } else {
      toks.push(`x=${t.x}`, `y=${t.y}`);
      if (t.space === "screen") toks.push(`space="screen"`);
    }
  }
  for (const [k, v] of Object.entries(step.params ?? {})) {
    // Не-строки (числа/булевы/объекты) кодируем JSON, чтобы не терять их в «[object Object]».
    const raw = typeof v === "string" ? v : JSON.stringify(v);
    toks.push(`${k}="${escapeAttr(raw)}"`);
  }
  if (step.expect?.role) toks.push(`expectRole="${escapeAttr(step.expect.role)}"`);
  if (step.expect?.name) toks.push(`expectName="${escapeAttr(step.expect.name)}"`);
  if (step.expect?.state) toks.push(`expectState="${escapeAttr(step.expect.state)}"`);
  if (step.timeoutMs !== undefined) toks.push(`timeoutMs=${step.timeoutMs}`);
  if (step.retries !== undefined) toks.push(`retries=${step.retries}`);
  if (step.needsLlm) toks.push(`needsLlm="true"`);
  return `${index + 1}. ${toks.join(" ")}`;
}

/** Собрать SKILL.md из фронтматтера и шагов (канонический content_md, §8). */
export function serializeSkill(frontmatter: SkillFrontmatter, steps: readonly SkillStep[]): string {
  const fmLines: string[] = [];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v === undefined || v === null) continue;
    fmLines.push(`${k}: ${String(v)}`);
  }
  const body = steps.map((s, i) => serializeStep(s, i)).join("\n");
  return `---\n${fmLines.join("\n")}\n---\n\n## Шаги\n${body}\n`;
}
