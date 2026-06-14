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
import type { SkillStep, Target, UiPattern } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { query } from "../db/pool.js";

const log: Logger = createLogger("skills");

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

/** Разобрать key="value" key2='v2' key3=v3 → словарь. */
function parseKeyValues(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w.]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const key = m[1]!;
    out[key] = m[2] ?? m[3] ?? m[4] ?? "";
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
    log.debug("saveSkill no-op (нет БД) — вернём derived в памяти");
    return {
      id,
      userId,
      version,
      contentMd,
      steps: parsed.steps,
      failCount: 0,
      updatedAt: Date.now(),
    };
  }
  return {
    id,
    userId,
    version,
    contentMd,
    steps: parsed.steps,
    failCount: 0,
    updatedAt: Date.now(),
  };
}

/** Прочитать навык по id (null если БД недоступна/не найден). */
export async function getSkill(userId: string, id: string): Promise<SkillRecord | null> {
  const res = await query(
    `select id, user_id, version, content_md, steps, fail_count,
            extract(epoch from updated_at) * 1000 as updated_at
       from skills where user_id = $1 and id = $2`,
    [userId, id],
  );
  const row = res?.rows[0];
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
  if (!res) return [];
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

/** Сериализовать шаг обратно в строку SKILL.md (обратимо к parseSkillMd). */
export function serializeStep(step: SkillStep, index: number): string {
  const toks: string[] = [step.action];
  const t = step.target;
  if (t) {
    if (t.by === "role") {
      toks.push(`role="${t.role}"`);
      if (t.name) toks.push(`name="${t.name}"`);
    } else if (t.by === "handle") {
      toks.push(`handle="${t.handle}"`);
    } else {
      toks.push(`x=${t.x}`, `y=${t.y}`);
    }
  }
  for (const [k, v] of Object.entries(step.params ?? {})) {
    toks.push(`${k}="${String(v)}"`);
  }
  if (step.expect?.role) toks.push(`expectRole="${step.expect.role}"`);
  if (step.expect?.name) toks.push(`expectName="${step.expect.name}"`);
  if (step.expect?.state) toks.push(`expectState="${step.expect.state}"`);
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
