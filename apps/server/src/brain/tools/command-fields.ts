/**
 * W2 (пакет 0, решение №9): сборка ActionCommand по ALLOWLIST полей схемы инструмента.
 *
 * Было `{kind, ...input}` — всё, что прислала модель, уезжало клиенту: `approval`/`commitApproved` (самоодобрение §14),
 * `expectedForeground`, `space` и любые будущие служебные поля. Денилист таких полей неполон по определению, поэтому
 * источник правды — сама схема (`pickBySchema`: лишнее срезается на любой глубине закрытой схемы — в target, rect,
 * условии wait_for). Служебные поля (`origin`, `approval`) после этого ставит ТОЛЬКО сервер.
 *
 * W2 П3: шаги input_batch — тоже по allowlist: шаг и цель — по схеме (модельный `space` в цели срезан), а свободные
 * `params` — по списку полей, которые реально читает исполнитель шага (skill-runner/client-actuator).
 */
import type { ActionKind, SkillStep } from "@jarvis/protocol";
import { REPLAY_TYPE_MAX_CHARS } from "@jarvis/protocol";
import { TOOLS_BY_NAME, pickBySchema } from "@jarvis/tools";

/** Поля схемы, которые раскрывает сам сервер и клиенту не шлёт: серию act{steps} исполняет act-steps по шагу. */
const SERVER_ONLY_FIELDS: Readonly<Partial<Record<ActionKind, readonly string[]>>> = { "gui.act": ["steps"] };

/**
 * Команда из входа модели: только поля схемы `name`. Инструмента без схемы не бывает (тест пакета tools), но на
 * такой случай — fail-closed: одна команда без полей модели.
 */
export function commandFromInput(kind: ActionKind, name: string, input: Record<string, unknown>): Record<string, unknown> & { kind: ActionKind } {
  const schema = TOOLS_BY_NAME[name]?.input_schema;
  const picked = (schema ? pickBySchema(schema, input) : {}) as Record<string, unknown>;
  for (const f of SERVER_ONLY_FIELDS[kind] ?? []) delete picked[f];
  return { ...picked, kind };
}

/**
 * §Волна2 (2.2): действия берста и поля `params`, которые исполнитель шага читает. Только то, что skill-runner
 * исполняет ДЕТЕРМИНИРОВАННО и БЕЗОПАСНО; незнакомое действие клиент молча пропустил бы (no-op) — ложный успех,
 * поэтому валидация здесь, до отправки. `space` (абсолютные DIP) — только у записанных макросов §8, не у модели.
 */
const BATCH_PARAMS: Readonly<Record<string, readonly string[]>> = {
  "app.launch": ["app"], "app.focus": ["app"], "browser.open": ["url"],
  "ui.invoke": ["pattern", "value"], "ui.ground": [],
  "input.type": ["text"], "input.key": ["combo", "mode", "scancode"], "input.click": ["method", "button", "count"],
  "input.mouse": ["op", "x", "y", "toX", "toY", "button", "dy", "dx", "frame"],
  wait: ["ms"], ground: [], verify: [],
};
export const BATCH_MAX_STEPS = 12;

const asObj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function pickParams(action: string, params: unknown): Record<string, unknown> | undefined {
  const p = asObj(params);
  if (!p) return undefined;
  const out = Object.fromEntries((BATCH_PARAMS[action] ?? []).filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Проверить один шаг берста; ошибка — честный текст (берст не отправляется). */
function stepError(i: number, raw: Record<string, unknown>, s: Record<string, unknown>): string | null {
  const action = String(raw.action ?? "").trim();
  if (!BATCH_PARAMS[action]) return `input_batch: шаг ${i + 1} — действие «${action}» в берсте не поддерживается. Разрешены: ${Object.keys(BATCH_PARAMS).join(", ")}. Прочее делай отдельными инструментами.`;
  if (raw.needsLlm) return `input_batch: шаг ${i + 1} с needsLlm в ad-hoc берсте невозможен — заполни значения сам.`;
  // Ревью фиксов, 2-й проход (R2): длинный input.type НЕотменяем (typeText даёт себе 5с+120мс/символ, до 180с >
  // серверного потолка 130с) → печатал бы параллельно LLM-петле в уже другое окно.
  const text = asObj(s.params)?.text;
  if (action === "input.type" && typeof text === "string" && text.length > REPLAY_TYPE_MAX_CHARS) {
    return `input_batch: шаг ${i + 1} — текст input.type длиннее ${REPLAY_TYPE_MAX_CHARS} символов не батчится (печать неотменяема и не влезает в бюджет реплея). Длинный текст — через fs_write/office_* или обычный input_type.`;
  }
  // Ревью Волны 2: expect без содержимого «подтверждается» безусловно (checkExpect: нет role → true) — требуем role/text.
  const expect = asObj(s.expect);
  if (expect && expect.kind === "visual" && !expect.text) return `input_batch: шаг ${i + 1} — expect visual без text (нечего проверять).`;
  if (expect && expect.kind !== "visual" && !expect.role) return `input_batch: шаг ${i + 1} — expect a11y без role (нечего проверять).`;
  // ui.ground в берсте исполняется только с target.by="role" (иначе клиент делает тихий no-op).
  if (action === "ui.ground" && asObj(s.target)?.by !== "role") return `input_batch: шаг ${i + 1} — ui.ground требует target {by:"role", role, name?}.`;
  return null;
}

/** Шаги input_batch → SkillStep[] по allowlist (или честная ошибка до отправки). */
export function batchStepsFromInput(input: Record<string, unknown>): { steps: SkillStep[] } | { error: string } {
  const rawSteps = Array.isArray(input.steps) ? (input.steps as unknown[]) : null;
  if (!rawSteps || rawSteps.length === 0) return { error: "input_batch: нужен steps[] (1..12 шагов)" };
  if (rawSteps.length > BATCH_MAX_STEPS) {
    return { error: `input_batch: слишком длинный берст (${rawSteps.length} шагов, максимум ${BATCH_MAX_STEPS}) — компаундинг-риск, разбей на части со сверкой между ними.` };
  }
  const picked = pickBySchema(TOOLS_BY_NAME.input_batch?.input_schema, { steps: rawSteps }) as { steps: Record<string, unknown>[] };
  const steps: SkillStep[] = [];
  for (let i = 0; i < rawSteps.length; i += 1) {
    const raw = asObj(rawSteps[i]) ?? {};
    const s = asObj(picked.steps[i]) ?? {};
    const e = stepError(i, raw, s);
    if (e) return { error: e };
    const action = String(raw.action).trim();
    const expect = asObj(s.expect) as SkillStep["expect"];
    const pre = asObj(s.precondition);
    steps.push({
      action,
      target: asObj(s.target) as SkillStep["target"],
      params: pickParams(action, s.params),
      expect,
      // §Волна3 (3.3): предусловие шага — живой стейт до исполнения (валидирует клиентский раннер).
      precondition: typeof pre?.role === "string" ? (pre as SkillStep["precondition"]) : undefined,
      timeoutMs: typeof s.timeoutMs === "number" ? s.timeoutMs : undefined,
      // Ревью Волны 2: у слепого шага (без expect) НЕТ критерия неудачи → ретраи переисполняли бы неидемпотентное
      // действие. Без expect — 0 повторов; retries из контента клампим (R3: sleep(200·attempt) раздувал хвост).
      retries: typeof s.retries === "number" ? Math.max(0, Math.min(3, Math.floor(s.retries))) : expect ? undefined : 0,
    });
  }
  return { steps };
}
