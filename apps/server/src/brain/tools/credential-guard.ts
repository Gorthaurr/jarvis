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
}

/**
 * Подпись поля по ref (browser_act{params.ref} / browser_batch) — её знает ТОЛЬКО последний
 * browser_inspect, поэтому резолвер приходит снаружи (dispatch отдаёт `refFieldHint`). Без него
 * ref остаётся немым, и берст логин-формы гардом не разбирается вовсе.
 */
export type RefHintResolver = (ref: string) => string | undefined;

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

function hintsFromParams(params: Record<string, unknown> | undefined, refHint?: RefHintResolver): string[] {
  if (!params) return [];
  const out: string[] = [];
  for (const k of HINT_KEYS) {
    const v = params[k];
    if (typeof v === "string" && v.trim()) out.push(v);
  }
  // Сам «e3_5» немой — но снимок browser_inspect знает подпись этого элемента (см. refFieldHint).
  const ref = params.ref;
  if (typeof ref === "string" && ref.trim() && refHint) {
    const h = refHint(ref);
    if (h) out.push(h);
  }
  return out;
}

/** Признак поля у UIA-адресации: by:"role" несёт имя/роль элемента («Пароль»); by:"handle"/"coords" — ничего. */
function hintsFromTarget(target: unknown): string[] {
  const t = asRecord(target);
  if (!t) return [];
  return [t.name, t.role].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function field(text: unknown, hints: string[]): TypedField[] {
  return typeof text === "string" && text.length > 0 ? [{ text, hints }] : [];
}

/** Шаги берста: браузерный ({intent,params}) и нативный SkillStep ({action,target,params}). */
function stepFields(raw: unknown, shape: "browser" | "native", refHint?: RefHintResolver): TypedField[] {
  if (!Array.isArray(raw)) return [];
  const out: TypedField[] = [];
  for (const s of raw) {
    const step = asRecord(s);
    if (!step) continue;
    const p = asRecord(step.params);
    if (shape === "browser") {
      // В берсте ref лежит НА ШАГЕ, а не в params — иначе подпись поля не нашлась бы (логин-форма).
      const withRef = { ...(p ?? {}), ...(typeof step.ref === "string" ? { ref: step.ref } : {}) };
      if (String(step.intent ?? "") === "type") out.push(...field(p?.text, hintsFromParams(withRef, refHint)));
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
export function collectTypedFields(tool: string, input: Record<string, unknown>, refHint?: RefHintResolver): TypedField[] {
  // browser_act допускает и плоскую форму (params отсутствует) — берём то же, что берёт хендлер.
  const params = asRecord(input.params) ?? input;
  switch (tool) {
    case "input_type":
      return field(input.text, []); // синтетический ввод «в активный элемент» — про поле НЕ известно ничего
    case "system_clipboard":
      return String(input.op ?? "") === "write" ? field(input.text, []) : [];
    case "ui_invoke":
      return String(input.pattern ?? "") === "setValue" ? field(input.value, hintsFromTarget(input.target)) : [];
    case "browser_act":
    case "web_act":
      return String(input.intent ?? "") === "type" ? field(params.text, hintsFromParams(params, refHint)) : [];
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
): CredentialVerdict {
  let note: string | undefined;
  for (const f of collectTypedFields(tool, input, refHint)) {
    const hint = f.hints.join(" ");
    if (carriesCardNumber(f.text) || CARD_FIELD_RE.test(hint)) {
      return {
        block:
          `${tool}: это платёжные реквизиты — номера карт, CVV и сроки действия я не ввожу и не храню (§0, красная линия). ` +
          `Их вводит владелец сам. Могу открыть нужную страницу и подождать.`,
      };
    }
    if (PASSWORD_FIELD_RE.test(hint) || OTP_FIELD_RE.test(hint)) {
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
