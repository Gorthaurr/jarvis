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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillStep, Target, UiPattern } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { query } from "../db/pool.js";

const log: Logger = createLogger("skills");

/** Папка осязаемых SKILL.md на диске (рядом с рабочей директорией сервера, §8). */
const SKILLS_DIR = join(process.cwd(), "data", "skills");

/**
 * Префикс id выученных навыков-процедур (§8 HERMES). Развязывает их пространство имён с
 * записанными показом реплей-навыками (тот же `slugify(name)` иначе схлопнул бы их в один
 * ряд таблицы и upsert затёр бы друг друга). `__` slugify НИКОГДА не порождает (любой
 * не-`[a-z0-9-]` → `-`), поэтому learned-id не может совпасть с demonstrated-id.
 */
const LEARNED_ID_PREFIX = "learned__";

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
    "role", "name", "handle", "x", "y", "by",
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
    if (!Number.isNaN(x) && !Number.isNaN(y)) return { by: "coords", x, y };
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
    // БД недоступна → держим в памяти процесса (фолбэк), чтобы recall в этой сессии нашёл навык.
    memSkills.set(memKey(userId, id), record);
    log.debug("saveSkill: БД нет — навык сохранён в памяти процесса (фолбэк)");
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

/** Удалить навык. Возвращает true, если запрос ушёл в БД. */
export async function deleteSkill(userId: string, id: string): Promise<boolean> {
  const res = await query(`delete from skills where user_id = $1 and id = $2`, [userId, id]);
  return res !== null;
}

// ── Провайдер навыков для agent-loop (§8): каталог + резолв для skill_execute ──

/** Краткая карточка навыка для каталога модели (skill_list). */
export interface SkillInfo {
  id: string;
  name: string;
  version: number;
  /** Есть guard-шаги (message.send/order.place/code.run/confirm) → нужно подтверждение (§14). */
  needsReview: boolean;
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
}

export interface SkillProvider {
  /** Каталог РЕПЛЕЙ-навыков (записанных показом) для skill_list/skill_execute (§8). */
  list(userId: string): Promise<SkillInfo[]>;
  /** Резолв реплей-навыка по id для skill_execute (§8). Выученные-процедуры сюда не входят. */
  get(userId: string, id: string): Promise<ResolvedSkill | null>;
  /** Сохранить выученный навык-процедуру (§8 HERMES, инструмент skill_save). */
  save(userId: string, input: LearnedSkillInput): Promise<SavedLearnedSkill | null>;
  /** Подобрать подходящий выученный навык под текст задачи (recall, §8). null — нет. */
  recall(userId: string, text: string): Promise<RecalledSkill | null>;
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
 * Стемминг-матч с ДЛИНОЗАВИСИМЫМ порогом общего префикса (§8). Точное совпадение — всегда
 * матч. Иначе нужен общий префикс ≥ max(5, ⌈0.75·min(len)⌉): это терпит русскую морфологию
 * («отчёт»/«отчёта», «отправь»/«отправить»), но НЕ ловит чужие слова с коротким общим
 * префиксом («столкнулся»/«столица», «почта»/«почти», «привет»/«приватный») — ложный recall
 * вреднее пропуска. Короткие токены (4 симв.) матчатся только точно.
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
 * Подобрать лучший выученный навык под текст задачи (§8 HERMES). Лексический матч с
 * грубым стеммингом по имени+описанию навыка. Порог намеренно консервативный (≥2
 * значимых попадания и ≥1/3 перекрытие): ложный recall вреднее пропуска — лишняя
 * процедура в промпте сбивает; пропущенный навык модель просто переоткроет. Чистая
 * функция (без БД) — для прямого юнит-теста.
 */
export function matchLearnedSkill(text: string, skills: readonly RecalledSkill[]): RecalledSkill | null {
  const q = new Set(skillTokens(text));
  if (q.size === 0) return null;
  let best: RecalledSkill | null = null;
  let bestScore = 0;
  for (const s of skills) {
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
  return bestScore >= 0.34 ? best : null;
}

/** Человекочитаемое имя навыка из фронтматтера (иначе — id). */
function skillName(rec: SkillRecord): string {
  return String(parseSkillMd(rec.contentMd).frontmatter.name ?? rec.id);
}

/** Адаптер над listSkills/getSkill: каталог и резолв навыков для мозга (§8). */
export function createSkillProvider(): SkillProvider {
  return {
    async list(userId) {
      const recs = await listSkills(userId);
      // Выученные-процедуры (HERMES) не реплеятся — их место в recall, а не в skill_execute.
      return recs
        .filter((r) => !isLearnedMd(r.contentMd))
        .map((r) => ({ id: r.id, name: skillName(r), version: r.version, needsReview: hasGuardSteps(r.steps) }));
    },
    async get(userId, id) {
      const r = await getSkill(userId, id);
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
      const id = LEARNED_ID_PREFIX + slugify(name);
      // Повторное сохранение того же навыка — новая версия (улучшение, §8): version++.
      const existing = await getSkill(userId, id);
      const version = existing ? existing.version + 1 : 1;
      const contentMd = serializeLearnedSkill({ id, name, version, when: input.when, procedure: input.procedure });
      const rec = await saveSkill(userId, contentMd);
      await writeSkillFile(id, contentMd);
      return { id, name, version: rec?.version ?? version };
    },
    async recall(userId, text) {
      const recs = await listSkills(userId);
      const learned = recs
        .map(readLearned)
        .filter((x): x is RecalledSkill => x !== null);
      return matchLearnedSkill(text, learned);
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
