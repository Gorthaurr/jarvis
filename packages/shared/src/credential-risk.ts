/**
 * W2 (пакет 0): ПРИЗНАКИ СЕКРЕТОВ (§0 принцип 5) — одна эвристика на сервер (credential-guard, order-guard) и клиент
 * (рубеж инжекции П2). Перенесено без изменения поведения: серверные тесты гарда и заказа это доказывают.
 *
 * ⚠️ Ложное срабатывание дороже пропуска: голые 4-6 цифр — год, сумма, номер дома. Карта — только кандидат 13-19
 * цифр с одним типовым разделителем, прошедший Луна; поле пароля/кода — только по признаку САМОГО поля.
 */

// Поле пароля. Целыми словами: «pass» отдельно матчит passenger/passport.
export const PASSWORD_FIELD_RE = /парол|password|passwd|passphrase|\bpwd\b|passcode/iu;
// Поле одноразового кода/второго фактора. «code» отдельно НЕ берём — это промокод, индекс и редактор кода.
export const OTP_FIELD_RE =
  /\botp\b|one[-_ ]?time|\btotp\b|\b2fa\b|\bmfa\b|sms[-_ ]?code|verification[-_ ]?code|confirmation[-_ ]?code|auth[-_ ]?code|security[-_ ]?code|\bpin[-_ ]?code\b|код\s*из\s*(смс|sms)|смс[-\s]?код|код\s*подтвержден|одноразов\p{L}*\s*(код|парол)|пин[-\s]?код/iu;
// Поле платёжных реквизитов. Голое `card` НЕ берём: класс `.card` из Bootstrap стоит на половине сайтов.
export const CARD_FIELD_RE = /card[-_ ]?(number|num|no)\b|cardnumber|\bcvv2?\b|\bcvc2?\b|номер\s*карты|card[-_ ]?holder/iu;

/**
 * Luhn-чек (контрольная сумма карты): не путать карту с EAN-13, артикулом, телефоном или суммой в копейках.
 */
export function passesLuhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// Изолированный 13-19-значный токен после нормализации разделителей (границы — не-цифры).
const CARD_NUMBER_RE = /(?<!\d)\d{13,19}(?!\d)/g;
// Разделители номера — ЛЮБОЙ не-алфанум (запятая, NBSP, скобки…): узкий класс пропускал «4111,1111,1111,1111».
const CARD_SEP_RE = /[^0-9A-Za-z]/g;

/** Строка несёт номер карты: без разделителей есть 13-19 цифр подряд, прошедших Луна (ядро order-guard). */
export function cardNumberIn(value: string): boolean {
  const compact = String(value ?? "").replace(CARD_SEP_RE, "");
  for (const m of compact.matchAll(CARD_NUMBER_RE)) if (passesLuhn(m[0])) return true;
  return false;
}

/**
 * Кандидат в карту в СВОБОДНОМ тексте: 13-19 цифр, разделённых максимум одним типовым разделителем. Всю строку
 * в `cardNumberIn` не кормим: кириллица-разделитель склеивала цифры разных слов («120000; // 2026 год, v1.2.3»).
 */
const CARD_CANDIDATE_RE = /(?<!\d)\d(?:[ \t\-.,/ ]?\d){12,18}(?!\d)/g;

/** Номер карты в печатаемом тексте (Луна по кандидатам). */
export function carriesCardNumber(text: string): boolean {
  for (const m of String(text ?? "").matchAll(CARD_CANDIDATE_RE)) if (cardNumberIn(m[0])) return true;
  return false;
}

/** Признак поля пароля или одноразового кода по подсказкам (подпись, имя UIA, automationId, селектор). */
export function looksLikeSecretField(hints: string | readonly string[]): boolean {
  const h = typeof hints === "string" ? hints : hints.join(" ");
  return PASSWORD_FIELD_RE.test(h) || OTP_FIELD_RE.test(h);
}

/** Элемент в фокусе из выжимки `read.screen` сайдкара. */
export interface FocusedLine {
  /** Роль без «ControlType.»: Edit, Button… */
  role: string;
  name: string;
  /** Сайдкар пометил поле-пароль `[ЗАЩИЩЕНО]` (UIA IsPassword) — значение он не читал. */
  secret: boolean;
}

/**
 * Первая строка `read.screen` (UiaGrounder.CollectText): «ControlType.Edit: Пароль [ЗАЩИЩЕНО]», «ControlType.Button:
 * Отправить», «ControlType.Edit: Поиск [ПУСТО]», «ControlType.Edit: Имя [значение]». Нет строки роли → null.
 */
export function parseFocusedLine(readScreenText: string): FocusedLine | null {
  const line = String(readScreenText ?? "").split(/\r?\n/u).find((l) => l.trim()) ?? "";
  const m = /^\s*(?:ControlType\.)?([A-Za-z]+):\s?(.*)$/u.exec(line);
  if (!m) return null;
  let rest = m[2]!.trimEnd();
  const secret = rest.endsWith(" [ЗАЩИЩЕНО]") || rest === "[ЗАЩИЩЕНО]";
  const bracket = rest.lastIndexOf(" [");
  if (rest.endsWith("]") && bracket >= 0) rest = rest.slice(0, bracket);
  else if (secret) rest = "";
  return { role: m[1]!, name: rest.trim(), secret };
}
