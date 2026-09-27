/**
 * W2 (П3, G-3(4), S-5, S-6): МЕСТА ВВОДА ТЕКСТА в GUI и что известно про поле — для гарда §0 (credential-guard).
 *
 * Печать «в фокус» немая: input_type, act{type} без цели, Ctrl+V и шаг input.type берста не знают, в какое поле
 * пишут. Раньше гард видел у них пустые признаки поля и только предупреждал — «клик «Пароль» → печать» проходил.
 * Теперь печать в фокус наследует НАВЕДЁННУЮ цель (последний клик/act/ui_invoke сессии, в берсте — предыдущий шаг):
 * её подпись и признак секрета (поле «•••» в снимке). Смена окна (app.focus/app.launch) и уход фокуса (Tab/Enter,
 * клик мышью) цепочку рвут. Вставка (Ctrl+V/Shift+Insert/Ctrl+Shift+V) судится как печать содержимого буфера обмена.
 *
 * Это защита в глубину: главный рубеж §0 — клиентский (фокус и буфер обмена по факту, П2).
 */
import { keyClass } from "@jarvis/shared";

/** Одно место ввода: ЧТО печатаем и что известно про САМО поле (селектор/лейбл/имя элемента). */
export interface TypedField {
  text: string;
  /** Пусто = на этом пути про поле не известно НИЧЕГО → блокировать нечем (только предупреждение). */
  hints: string[];
  /** Поле помечено секретным (снимок страницы/окна: type=password, «•••»). */
  secret?: boolean;
}

/** Что известно о поле в фокусе (наведённая цель) и о буфере обмена. */
export interface FocusFacts {
  hints: string[];
  secret?: boolean;
  /** Последнее, что Джарвис положил в буфер обмена (system_clipboard write). */
  clipboard?: string;
}

/** Подпись и признак секрета UIA-элемента по handle (память look{elements}/ui_snapshot) — handle сам по себе немой. */
export type HandleHintResolver = (handle: unknown) => string | { hint?: string; secret?: boolean } | undefined;

const asRecord = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const strs = (...v: unknown[]): string[] => v.filter((s): s is string => typeof s === "string" && s.trim().length > 0);

/**
 * Р2 srv-bypass-3: судим ровно то, что НАПЕЧАТАЕТСЯ. Аргументы SDK — свободный объект (z.looseObject), а расширение печатает
 * `String(P.text)`: номер карты или код числом (4111111111111111, 123456) раньше проходил мимо Луны и признака поля.
 */
export function field(text: unknown, hints: string[], secret = false): TypedField[] {
  const s = text === undefined || text === null ? "" : String(text);
  return s.length > 0 ? [{ text: s, hints, ...(secret ? { secret } : {}) }] : [];
}

/** Признаки поля UIA-цели: by:"role" несёт имя/роль («Пароль»); by:"handle" — подпись и секрет из памяти снимка. */
export function targetField(target: unknown, handleHint?: HandleHintResolver): FocusFacts {
  const t = asRecord(target);
  if (!t) return typeof target === "string" && target.trim() ? { hints: [target] } : { hints: [] };
  const hints = strs(t.text, t.name, t.role, t.automationId);
  if (t.handle === undefined || !handleHint) return { hints };
  const info = handleHint(t.handle);
  const hint = typeof info === "string" ? info : info?.hint;
  return { hints: hint ? [...hints, hint] : hints, secret: typeof info === "object" && info?.secret === true };
}

/** Вставка из буфера обмена = печать его содержимого в поле с фокусом (содержимое неизвестно — судим поле). */
export function pasteField(combo: unknown, focus: FocusFacts | undefined): TypedField[] {
  if (keyClass(String(combo ?? "")) !== "paste") return [];
  return [{ text: focus?.clipboard ?? "", hints: focus?.hints ?? [], ...(focus?.secret ? { secret: true } : {}) }];
}

/** Клавиша уводит фокус из поля: Tab/Enter/Esc и сочетания-коммиты (не печать, не правка, не вставка). */
function leavesField(combo: string): boolean {
  const cls = keyClass(combo);
  return cls === "focusPress" || cls === "commit" || /(^|\+)\s*(tab|esc|escape)\s*$/iu.test(combo.trim());
}

/**
 * Шаги нативного берста/навыка (SkillStep {action,target,params}) с цепочкой «клик → печать»: input.type без цели
 * печатает в поле, куда кликнул прошлый шаг (или в наведённую цель сессии — `start`).
 */
export function nativeStepFields(raw: unknown, handleHint?: HandleHintResolver, start?: FocusFacts): TypedField[] {
  if (!Array.isArray(raw)) return [];
  const out: TypedField[] = [];
  let focus: FocusFacts | undefined = start;
  for (const s of raw) {
    const step = asRecord(s);
    if (!step) continue;
    const p = asRecord(step.params);
    const action = String(step.action ?? "");
    const aimed = step.target !== undefined ? targetField(step.target, handleHint) : undefined;
    if (action === "app.focus" || action === "app.launch" || action === "browser.open") focus = undefined;
    else if (action === "input.click") focus = aimed;
    else if (action === "input.mouse" && (p?.op === "down" || p?.op === "drag")) focus = undefined;
    else if (action === "ui.invoke") {
      // В SkillStep паттерн и значение ui.invoke лежат в params (см. replayUnsafe) — форма другая, путь тот же.
      if (String(p?.pattern ?? "") === "setValue") out.push(...field(p?.value, aimed?.hints ?? [], aimed?.secret));
      focus = aimed;
    } else if (action === "input.type") {
      const f = aimed ?? focus;
      out.push(...field(p?.text, f?.hints ?? [], f?.secret));
    } else if (action === "input.key") {
      out.push(...pasteField(p?.combo, { hints: focus?.hints ?? [], secret: focus?.secret, clipboard: start?.clipboard }));
      if (leavesField(String(p?.combo ?? ""))) focus = undefined;
    }
  }
  return out;
}
