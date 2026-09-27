/**
 * Память ref → «что за элемент» из снимков browser_inspect (per-сессия) и форма ответа снимка модели.
 *
 * §0 гард учётных данных: берст (browser_batch) и ref-адресация не несут ни селектора, ни лейбла — «e3_5» немой, и
 * гард ввода не отличил бы поле пароля от поиска. Снимок ЗНАЕТ подпись и (W1, контракт §2) признак `secret`
 * (type=password, autocomplete current-password/one-time-code/cc-*) — запоминаем их.
 * W1: результаты find (inspect{query}) ДОПИСЫВАЮТСЯ в реестр расширения, прежние ref живы → карту НЕ заменяем, а
 * дописываем (раньше каждый снимок затирал её — после find подпись поля пароля терялась, и type по его ref шёл мимо
 * гарда). Переполнение вытесняет самые старые записи.
 *
 * ⚠️ Подписи — данные СТРАНИЦЫ (M11), используются только в безопасную сторону: «похоже на пароль → откажусь»,
 * «похоже на коммит → спрошу». Враждебная страница добьётся лишь лишнего отказа/вопроса.
 */
import type { ToolContext } from "../dispatch.js";

export interface RefInfo {
  /** Признаки поля для §0 (пароль/код/карта): имя/текст/подпись + selector/role/type (`#password` — тоже признак). */
  hint: string;
  /**
   * ВИДИМЫЕ подписи (имя/текст/label/aria) — по ним §14 судит клик и их же показывает владельцу. W1-D6: суд по хинту
   * брал слово submit из селектора `input[type="submit"][name="next"]` и типа — «Следующая страница» теста Moodle
   * судилась сдачей; вопрос владельцу показывал CSS-селектор («Оплатить #payform > button:nth-of-type(1) button»).
   */
  labels: string[];
  /** Подпись ОДОБРЕНИЯ §14 — видимое имя элемента (без selector/role/type): её страница сверяет с подписью цели. */
  approval: string;
  secret: boolean;
}

const refInfos = new WeakMap<object, Map<string, RefInfo>>();
const REF_INFOS_MAX = 400;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Поле ввода по снимку (tag/role/state ровно как их отдаёт inspectPageInPage): у него `text` — СОДЕРЖИМОЕ (редактор,
 * contenteditable), а не подпись. W1-ревью р2 (srv-tests-2): текст письма «…пароль от вайфая…» в хинте давал §0-отказ.
 */
function isEditable(e: Record<string, unknown>): boolean {
  const state = e.state && typeof e.state === "object" ? (e.state as Record<string, unknown>) : {};
  return /^(input|textarea)$/u.test(str(e.tag)) || /^(textbox|searchbox)$/u.test(str(e.role)) || (str(e.tag) !== "select" && "value" in state);
}

export function rememberRefHints(ctx: ToolContext, elements: unknown): void {
  const sess = ctx.session as unknown as object | undefined;
  if (!sess || !Array.isArray(elements)) return;
  let map = refInfos.get(sess);
  if (!map) refInfos.set(sess, (map = new Map()));
  for (const raw of elements) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.ref !== "string" || !e.ref) continue;
    // W1-T9: видимый текст (e.text — у кнопок, чьё aria-имя расходится с надписью) — тоже подпись: без него §14
    // судил бы «Действие» вместо «Оплатить заказ». Кроме полей ввода: там e.text — содержимое, не подпись.
    const text = isEditable(e) ? "" : str(e.text);
    const hint = [e.name, text, e.label, e.aria, e.selector, e.role, e.type].map(str).filter(Boolean).join(" ").slice(0, 160);
    const labels = [...new Set([e.name, text, e.label, e.aria].map(str).filter(Boolean))];
    // Контракт одобрения (W1-ревью р2, NEW-1): одна видимая подпись — её страница сравнивает с частью подписи цели.
    const approval = labels[0] ?? "";
    map.delete(e.ref); // свежая запись — в конец порядка вытеснения
    map.set(e.ref, { hint, labels, approval, secret: e.secret === true });
  }
  while (map.size > REF_INFOS_MAX) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Что известно про элемент по ref из снимков сессии. Нет → undefined (гард не блокирует вслепую). */
export function refFieldInfo(ctx: ToolContext, ref: string): RefInfo | undefined {
  const sess = ctx.session as unknown as object | undefined;
  return sess ? refInfos.get(sess)?.get(ref) : undefined;
}

/** Подпись элемента по ref (для §14: «клик по ref с подписью-коммитом»). Пустая подпись → undefined. */
export function refFieldHint(ctx: ToolContext, ref: string): string | undefined {
  return refFieldInfo(ctx, ref)?.hint || undefined;
}

/** Видимые подписи цели по ref для суда §14 и вопроса владельцу (без selector/role/type). Нет снимка → []. */
export function refCommitLabels(ctx: ToolContext, ref: unknown): string[] {
  return typeof ref === "string" ? (refFieldInfo(ctx, ref)?.labels ?? []) : [];
}

/** Подпись одобрения §14 для цели по ref (видимое имя). Нет снимка или имени → undefined. */
export function refApprovalLabel(ctx: ToolContext, ref: unknown): string | undefined {
  return typeof ref === "string" ? refFieldInfo(ctx, ref)?.approval || undefined : undefined;
}

// ── B-16: кап снимка ────────────────────────────────────────────────────────────────────────────────────────────
/** Потолок элементов от модели (расширение по умолчанию отдаёт 80; find — до 20). */
export const INSPECT_MAX_ELEMENTS = 150;
/** Потолок символов JSON снимка ВНУТРИ untrusted (≈5K токенов): длинные value/подписи не раздувают контекст. */
export const INSPECT_MAX_CHARS = 16_000;
const FIELD_CAP = 300;
/** Поля, которые модель копирует КАК ЕСТЬ (адресация) — не режем, иначе селектор/ref станет неверным. */
const VERBATIM = new Set(["ref", "selector"]);

export function clampInspectCap(cap: unknown): number | undefined {
  if (typeof cap !== "number" || !Number.isFinite(cap)) return undefined;
  return Math.max(1, Math.min(INSPECT_MAX_ELEMENTS, Math.floor(cap)));
}

function clampElement(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = typeof v === "string" && !VERBATIM.has(k) && v.length > FIELD_CAP ? `${v.slice(0, FIELD_CAP)}…` : v;
  }
  return out;
}

/**
 * Элементы снимка под кап: строки длиннее FIELD_CAP режутся (кроме ref/selector), хвост элементов сверх
 * INSPECT_MAX_CHARS отбрасывается. `dropped` — сколько не показано (пометка ставится СНАРУЖИ untrusted).
 */
export function capInspectElements(elements: unknown): { elements: unknown[]; dropped: number } {
  const all = Array.isArray(elements) ? elements.map(clampElement) : [];
  const kept: unknown[] = [];
  let size = 2;
  for (const el of all) {
    const len = JSON.stringify(el).length + 1;
    if (size + len > INSPECT_MAX_CHARS) break;
    kept.push(el);
    size += len;
  }
  return { elements: kept, dropped: all.length - kept.length };
}
