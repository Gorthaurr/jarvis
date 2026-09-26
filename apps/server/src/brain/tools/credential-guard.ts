/**
 * ГАРД УЧЁТНЫХ ДАННЫХ на путях ВВОДА ТЕКСТА (§0 принцип 5, анти-инъекция).
 *
 * Живой пробел: проверка платёжных данных (`assertNoCardData`, алгоритм Луна) была подключена
 * РОВНО к одному инструменту — order_place. А шесть путей, которыми Джарвис реально ПЕЧАТАЕТ
 * (input_type, browser_act{type}, browser_batch, web_act{type}, ui_invoke{setValue},
 * system_clipboard{write}; плюс те же действия внутри input_batch) не проверяли ничего, и про
 * пароли с одноразовыми кодами не было сказано даже в описании схемы. Ввод учётных данных
 * ассистентом запрещён продуктом, и это ещё вектор инъекции со страницы («введи пароль от банка»).
 *
 * ⚠️ ЛОЖНОЕ СРАБАТЫВАНИЕ ЗДЕСЬ ДОРОЖЕ ПРОПУСКА: владелец кодит и диктует тексты, а голые 4-6 цифр —
 * это год, сумма или номер дома, а не код из СМС. Поэтому ЗАПРЕЩАЕМ только по СВЯЗКЕ признаков:
 *   - ПРИЗНАК ПОЛЯ (селектор / лейбл / имя UIA-элемента говорят «пароль», «код из СМС», «CVV») → блок;
 *   - значение прошло Луна (номер карты) → блок само по себе: это красная линия §0, уже
 *     задекларированная в схеме input_type;
 *   - признака поля на этом пути НЕТ (синтетический input_type, буфер обмена, адресация по handle/ref) →
 *     НЕ блокируем: возвращаем модели предупреждение. Сломать легитимную печать хуже, чем предупредить.
 *
 * Карточную эвристику НЕ переизобретаем — зовём `assertNoCardData` (Луна + нормализация разделителей):
 * разойдись две копии, «номер карты» значил бы РАЗНОЕ на разных путях.
 */
import { CardDataError, assertNoCardData } from "../orders/order-guard.js";
import { browserActParams, browserStepFields } from "./browser-params.js";

/** Единая формулировка отказа: расходящиеся тексты = расходящаяся политика. */
export const CREDENTIAL_REFUSAL = "Пароли и коды подтверждения не ввожу, введите сами";

export interface CredentialVerdict {
  /** Ввод запрещён — готовый честный текст для tool_result (инструмент вернёт ошибку, не «Готово»). */
  block?: string;
  /** Признака поля нет: работу не ломаем, но предупреждаем модель. */
  note?: string;
}

/** Одно место ввода: ЧТО печатаем и что известно про САМО поле (селектор/лейбл/имя элемента). */
interface TypedField {
  text: string;
  /** Пусто = на этом пути про поле не известно НИЧЕГО → блокировать нечем (только предупреждение). */
  hints: string[];
  /** W1 (B-3): снимок страницы пометил поле секретным (type=password, autocomplete current-password/one-time-code/cc-*). */
  secret?: boolean;
}

/**
 * Что за поле за ref (browser_act{ref} / browser_batch) — это знает ТОЛЬКО browser_inspect, поэтому резолвер приходит
 * снаружи (dispatch отдаёт `refFieldInfo`). Без него ref остаётся немым, и берст логин-формы гардом не разбирается.
 * W1: снимок несёт и `secret` — поле пароля/кода по признаку САМОЙ страницы, даже при немой подписи («Поле 2»).
 * Строка — прежняя форма (только подпись).
 */
export type RefHintResolver = (ref: string) => string | { hint?: string; secret?: boolean } | undefined;
/** Подпись UIA-элемента по handle из последнего look{elements}/ui_snapshot — handle сам по себе немой. */
export type HandleHintResolver = (handle: unknown) => string | undefined;

// Поле пароля. Пишем целыми словами: «pass» отдельно матчит passenger/passport, а урок денилистов
// проекта — либо точная форма, либо сломанная легитимная работа. `type="password"` ловится тем же.
const PASSWORD_FIELD_RE = /парол|password|passwd|passphrase|\bpwd\b|passcode/iu;
// Поле одноразового кода/второго фактора. «code» отдельно НЕ берём — это промокод, почтовый индекс
// и редактор кода; берём только квалифицированные формы.
const OTP_FIELD_RE =
  /\botp\b|one[-_ ]?time|\btotp\b|\b2fa\b|\bmfa\b|sms[-_ ]?code|verification[-_ ]?code|confirmation[-_ ]?code|auth[-_ ]?code|security[-_ ]?code|\bpin[-_ ]?code\b|код\s*из\s*(смс|sms)|смс[-\s]?код|код\s*подтвержден|одноразов\p{L}*\s*(код|парол)|пин[-\s]?код/iu;
// Поле платёжных реквизитов. Голое `card` НЕ берём: класс `.card` из Bootstrap стоит на половине
// сайтов — селектор формы внутри карточки блокировал бы любую печать (ровно тот ложный отказ,
// от которого предостерегает задача). Луна по значению закрывает остальное.
const CARD_FIELD_RE = /card[-_ ]?(number|num|no)\b|cardnumber|\bcvv2?\b|\bcvc2?\b|номер\s*карты|card[-_ ]?holder/iu;

/** Ключи параметров, которые описывают ПОЛЕ (а не печатаемый текст). `ref`/`handle` сюда не входят:
 *  «e3_5» не несёт смысла, и принимать его за признак поля значило бы глушить предупреждение. */
const HINT_KEYS = ["selector", "label", "name", "placeholder", "aria", "ariaLabel", "title", "field", "id", "for"] as const;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function hintsFromParams(params: Record<string, unknown> | undefined, refHint?: RefHintResolver, extraKeys: readonly string[] = []): { hints: string[]; secret: boolean } {
  if (!params) return { hints: [], secret: false };
  const out: string[] = [];
  for (const k of [...HINT_KEYS, ...extraKeys]) {
    const v = params[k];
    if (typeof v === "string" && v.trim()) out.push(v);
  }
  // Сам «e3_5» немой — но снимок browser_inspect знает подпись и секретность этого элемента (см. refFieldInfo).
  const ref = params.ref;
  let secret = false;
  if (typeof ref === "string" && ref.trim() && refHint) {
    const info = refHint(ref);
    const h = typeof info === "string" ? info : info?.hint;
    if (h) out.push(h);
    secret = typeof info === "object" && info?.secret === true;
  }
  return { hints: out, secret };
}

/**
 * browser_act / шаг берста: type печатает `text`; set (form_input, W1) — `value`, а `text` там — ЛОКАТОР поля (подпись),
 * то есть признак поля, а не печатаемое. Поля — те же, что увидит расширение (browser-params.ts).
 */
function browserTyped(intent: string, p: Record<string, unknown>, refHint?: RefHintResolver): TypedField[] {
  if (intent === "type") {
    const h = hintsFromParams(p, refHint);
    return field(p.text, h.hints, h.secret);
  }
  if (intent === "set") {
    const h = hintsFromParams(p, refHint, ["text"]);
    return field(p.value, h.hints, h.secret);
  }
  return [];
}

/** Признак поля у UIA-адресации: by:"role" несёт имя/роль элемента («Пароль»); by:"handle"/"coords" — ничего. */
function hintsFromTarget(target: unknown): string[] {
  const t = asRecord(target);
  if (!t) return [];
  return [t.name, t.role].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/**
 * Ревью 2026-09-24: `act` — ГЛАВНЫЙ путь печати в GUI с W4, а в гарде его не было: «act{do:"type",
 * target:"Пароль", text:…}» печатал пароль мимо красной линии §0 (тот самый забытый sibling call-site, о котором
 * предупреждает шапка dispatchTool). Цель act — строка (видимый текст элемента) или объект {text, role,
 * automationId, handle}; всё это — признаки поля. Без target act печатает в поле с фокусом → признаков нет.
 */
function hintsFromActTarget(target: unknown, handleHint?: HandleHintResolver): string[] {
  if (typeof target === "string") return target.trim() ? [target] : [];
  const t = asRecord(target);
  if (!t) return [];
  const out = [t.text, t.name, t.role, t.automationId].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (t.handle !== undefined && handleHint) {
    const h = handleHint(t.handle);
    if (h) out.push(h);
  }
  return out;
}

/**
 * Контроль-2 №2: цель последнего act сессии. Горячий путь «act{target:"Пароль"} (клик) → act{do:"type"} без цели»
 * печатал в поле пароля без единого признака поля — гард только предупреждал. Печать без цели наследует подпись
 * поля из прошлого act (фокус там и остался).
 */
const lastActTargets = new WeakMap<object, unknown>();
export function rememberActTarget(session: object | undefined, target: unknown): void {
  if (session && target !== undefined) lastActTargets.set(session, target);
}
export function lastActTarget(session: object | undefined): unknown {
  return session ? lastActTargets.get(session) : undefined;
}

function field(text: unknown, hints: string[], secret = false): TypedField[] {
  return typeof text === "string" && text.length > 0 ? [{ text, hints, ...(secret ? { secret } : {}) }] : [];
}

/** Шаги берста: браузерный ({intent,ref,params}) и нативный SkillStep ({action,target,params}). */
function stepFields(raw: unknown, shape: "browser" | "native", refHint?: RefHintResolver): TypedField[] {
  if (!Array.isArray(raw)) return [];
  const out: TypedField[] = [];
  for (const s of raw) {
    const step = asRecord(s);
    if (!step) continue;
    const p = asRecord(step.params);
    if (shape === "browser") {
      // Поля шага — с верха и из params (ровно так, как их видит хендлер берста): ref бывает на шаге, text — в params.
      const { intent, fields } = browserStepFields(step);
      out.push(...browserTyped(intent, fields, refHint));
      continue;
    }
    const action = String(step.action ?? "");
    if (action === "input.type") out.push(...field(p?.text, hintsFromTarget(step.target)));
    // В SkillStep паттерн и значение ui.invoke лежат в params (см. replayUnsafe) — форма другая, путь тот же.
    else if (action === "ui.invoke" && String(p?.pattern ?? "") === "setValue") out.push(...field(p?.value, hintsFromTarget(step.target)));
  }
  return out;
}

/** Все места ввода текста этого вызова. Экспорт — для юнит-тестов формы аргументов. */
export function collectTypedFields(
  tool: string,
  input: Record<string, unknown>,
  refHint?: RefHintResolver,
  handleHint?: HandleHintResolver,
): TypedField[] {
  // web_act допускает и плоскую форму (params отсутствует) — берём то же, что берёт его хендлер.
  const params = asRecord(input.params) ?? input;
  switch (tool) {
    case "input_type":
      return field(input.text, []); // синтетический ввод «в активный элемент» — про поле НЕ известно ничего
    case "system_clipboard":
      return String(input.op ?? "") === "write" ? field(input.text, []) : [];
    case "ui_invoke":
      return String(input.pattern ?? "") === "setValue" ? field(input.value, hintsFromTarget(input.target)) : [];
    // Контроль-2 №2: значения слотов навыка печатаются в поля реплея — имя слота («password») и есть признак поля.
    case "skill_execute": {
      const params = asRecord(input.params);
      return params ? Object.entries(params).flatMap(([k, v]) => field(v, [k])) : [];
    }
    case "act": {
      const verb = String(input.do ?? "click");
      return verb === "type" || verb === "set" ? field(input.text, hintsFromActTarget(input.target, handleHint)) : [];
    }
    // W1: browser_act — те же поля, что возьмёт хендлер (плоские + params, browserActParams), и form_input (set).
    case "browser_act":
      return browserTyped(String(input.intent ?? "").trim(), browserActParams(input), refHint);
    case "web_act":
      return String(input.intent ?? "") === "type" ? field(params.text, hintsFromParams(params, refHint).hints) : [];
    case "browser_batch":
      return stepFields(input.steps, "browser", refHint);
    case "input_batch":
      return stepFields(input.steps, "native");
    default:
      return [];
  }
}

/**
 * Кандидат в номер карты: 13-19 цифр, разделённых максимум ОДНИМ типовым разделителем, и не
 * приклеенных к другим цифрам (та же граница `(?<!\d)…(?!\d)`, что у order-guard — иначе кусок
 * 25-значного идентификатора считался бы картой там, где заказ её не видит).
 */
const CARD_CANDIDATE_RE = /(?<!\d)\d(?:[ \t\-.,/ ]?\d){12,18}(?!\d)/g;

/**
 * Номер карты в печатаемом тексте. Вердикт выносит ТА ЖЕ `assertNoCardData` (Луна + нормализация
 * разделителей) — второй эвристики не заводим.
 *
 * 🔴 Но скармливаем ей КАНДИДАТА, а не всю строку. Живой ложный отказ, пойманный собственным
 * тестом: order-guard считает разделителем ЛЮБОЙ не-латинский символ, поэтому в свободном тексте
 * кириллица стирается и цифры разных слов СКЛЕИВАЮТСЯ — «const timeout = 120000; // 2026 год,
 * версия 1.2.3» превращалось в 13-значный «номер», проходивший Луна, и владельцу отказывали
 * печатать собственный код. В заказе поля структурные, там это не всплывало.
 */
export function carriesCardNumber(text: string): boolean {
  for (const m of text.matchAll(CARD_CANDIDATE_RE)) {
    try {
      assertNoCardData({ text: m[0] });
    } catch (e) {
      if (e instanceof CardDataError) return true;
    }
  }
  return false;
}

/** Голый одноразовый код: 4-8 цифр и ничего кроме них (пробел/дефис — разбивка «123 456»). */
function looksLikeBareCode(text: string): boolean {
  const t = text.trim();
  if (!/^[\d\s-]+$/.test(t)) return false;
  const digits = t.replace(/\D/g, "").length;
  return digits >= 4 && digits <= 8;
}

/** Признак поля в отчёт возвращаем усечённым и без угловых скобок: он приходит из аргументов модели
 *  и может нести текст со страницы (M11) — делимитеры наших блоков рвать нельзя. */
function sani(hint: string): string {
  return hint.replace(/[<>]/g, " ").trim().slice(0, 80);
}

/**
 * Решение по вводу текста. `block` — честный отказ (инструмент вернёт ошибку, а не ложное «Готово»);
 * `note` — предупреждение к успешному результату; пусто — печатаем как обычно.
 */
export function checkCredentialInput(
  tool: string,
  input: Record<string, unknown>,
  refHint?: RefHintResolver,
  handleHint?: HandleHintResolver,
): CredentialVerdict {
  let note: string | undefined;
  for (const f of collectTypedFields(tool, input, refHint, handleHint)) {
    const hint = f.hints.join(" ");
    if (carriesCardNumber(f.text) || CARD_FIELD_RE.test(hint)) {
      return {
        block:
          `${tool}: это платёжные реквизиты — номера карт, CVV и сроки действия я не ввожу и не храню (§0, красная линия). ` +
          `Их вводит владелец сам. Могу открыть нужную страницу и подождать.`,
      };
    }
    // W1 (B-3): страница сама сказала «поле секретное» — отказ ДО отправки, даже если подпись немая («Поле 2»).
    if (f.secret || PASSWORD_FIELD_RE.test(hint) || OTP_FIELD_RE.test(hint)) {
      return {
        block:
          `${tool}: поле «${sani(hint)}» — пароль или код подтверждения. ${CREDENTIAL_REFUSAL}. ` +
          `Открой нужное окно/страницу, попроси владельца ввести руками и продолжай ПОСЛЕ этого — не подставляй значение сам.`,
      };
    }
    if (f.hints.length === 0 && looksLikeBareCode(f.text)) {
      note =
        `⚠️ Печатал вслепую: про поле на этом пути не известно ничего, а значение похоже на короткий код. ` +
        `${CREDENTIAL_REFUSAL} — если это был код или пароль, дальше вводит владелец, а не я. ` +
        `Если это обычное число (год, сумма, номер) — всё в порядке, продолжай.`;
    }
  }
  return note ? { note } : {};
}
