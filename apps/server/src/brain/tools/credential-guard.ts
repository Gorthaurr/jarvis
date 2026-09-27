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
// W2 (пакет 0): регэкспы полей и Луна — в @jarvis/shared/credential-risk (одна эвристика с клиентским рубежом §0).
import { CARD_FIELD_RE, OTP_FIELD_RE, PASSWORD_FIELD_RE, carriesCardNumber } from "@jarvis/shared";
import { browserActParams, browserStepFields } from "./browser-params.js";
import { type FocusFacts, type HandleHintResolver, type TypedField, field, nativeStepFields, pasteField, targetField } from "./credential-fields.js";

export { carriesCardNumber };
export type { FocusFacts, HandleHintResolver };

/** Единая формулировка отказа: расходящиеся тексты = расходящаяся политика. */
export const CREDENTIAL_REFUSAL = "Пароли и коды подтверждения не ввожу, введите сами";

export interface CredentialVerdict {
  /** Ввод запрещён — готовый честный текст для tool_result (инструмент вернёт ошибку, не «Готово»). */
  block?: string;
  /** Признака поля нет: работу не ломаем, но предупреждаем модель. */
  note?: string;
}

/**
 * Что за поле за ref (browser_act{ref} / browser_batch) — это знает ТОЛЬКО browser_inspect, поэтому резолвер приходит
 * снаружи (dispatch отдаёт `refFieldInfo`). Без него ref остаётся немым, и берст логин-формы гардом не разбирается.
 * W1: снимок несёт и `secret` — поле пароля/кода по признаку САМОЙ страницы, даже при немой подписи («Поле 2»).
 * Строка — прежняя форма (только подпись).
 */
export type RefHintResolver = (ref: string) => string | { hint?: string; secret?: boolean } | undefined;

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

/** Шаги браузерного берста ({intent,ref,params}): поля шага — с верха и из params, как их видит хендлер берста. */
function browserSteps(raw: unknown, refHint?: RefHintResolver): TypedField[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s) => {
    const step = asRecord(s);
    if (!step) return [];
    const { intent, fields } = browserStepFields(step);
    return browserTyped(intent, fields, refHint);
  });
}

/** Поле цели UIA/act (строка, {text,name,role,automationId}, handle → память снимка) — признаки и секрет. */
function uiField(text: unknown, target: unknown, handleHint?: HandleHintResolver): TypedField[] {
  const f = targetField(target, handleHint);
  return field(text, f.hints, f.secret);
}

/**
 * Все места ввода текста этого вызова. Экспорт — для юнит-тестов формы аргументов. `focus` — наведённая цель сессии
 * и буфер обмена (W2 S-6): печать без цели (input_type, act type/set без target) и вставка наследуют поле фокуса.
 */
export function collectTypedFields(
  tool: string,
  input: Record<string, unknown>,
  refHint?: RefHintResolver,
  handleHint?: HandleHintResolver,
  focus?: FocusFacts,
): TypedField[] {
  // web_act допускает и плоскую форму (params отсутствует) — берём то же, что берёт его хендлер.
  const params = asRecord(input.params) ?? input;
  switch (tool) {
    case "input_type": // синтетический ввод «в активный элемент» — про поле известна только наведённая цель
      return field(input.text, focus?.hints ?? [], focus?.secret);
    case "input_key":
      return input.mode === "up" ? [] : pasteField(input.combo, focus);
    case "system_clipboard":
      return String(input.op ?? "") === "write" ? field(input.text, []) : [];
    case "ui_invoke": // S-5: по голому handle поле видно из памяти снимка (подпись и «•••»)
      return String(input.pattern ?? "") === "setValue" ? uiField(input.value, input.target, handleHint) : [];
    // Контроль-2 №2: значения слотов навыка печатаются в поля реплея — имя слота («password») и есть признак поля.
    case "skill_execute": {
      const params = asRecord(input.params);
      return params ? Object.entries(params).flatMap(([k, v]) => field(v, [k])) : [];
    }
    // Ревью 2026-09-24: act — ГЛАВНЫЙ путь печати в GUI; цель — строка или {text, role, automationId, handle}.
    // Без target act печатает в поле с фокусом — признаки берём у наведённой цели (контроль-2 №2, W2 S-6).
    case "act": {
      const verb = String(input.do ?? "click");
      if (verb === "key") return pasteField(input.combo, focus);
      if (verb !== "type" && verb !== "set") return [];
      return input.target === undefined ? field(input.text, focus?.hints ?? [], focus?.secret) : uiField(input.text, input.target, handleHint);
    }
    // W1: browser_act — те же поля, что возьмёт хендлер (плоские + params, browserActParams), и form_input (set).
    case "browser_act":
      return browserTyped(String(input.intent ?? "").trim(), browserActParams(input), refHint);
    case "web_act":
      return String(input.intent ?? "") === "type" ? field(params.text, hintsFromParams(params, refHint).hints) : [];
    case "browser_batch":
      return browserSteps(input.steps, refHint);
    case "input_batch": // W2 G-3(4): цепочка «клик → печать» по шагам, старт — наведённая цель сессии
      return nativeStepFields(input.steps, handleHint, focus);
    default:
      return [];
  }
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
  focus?: FocusFacts,
): CredentialVerdict {
  let note: string | undefined;
  for (const f of collectTypedFields(tool, input, refHint, handleHint, focus)) {
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
          `${tool}: поле ${hint.trim() ? `«${sani(hint)}»` : "(помечено секретным)"} — пароль или код подтверждения. ${CREDENTIAL_REFUSAL}. ` +
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
