/**
 * W2 (П3): ПАМЯТЬ СЕССИИ серверных гейтов §0/§14 — что сервер знает о цели ДО исполнения.
 *
 * - handles: подпись UIA-элемента по handle из `look{elements}`/`ui_snapshot`/`ui_ground` — ТОЛЬКО имя (подпись
 *   коммита считает `commitSignature` по имени, роль отдельно — для allowlist безопасных целей), плюс признак
 *   секрета (снимок пометил поле-пароль значением «•••» или имя/automationId говорят «пароль/код»). S-1: гейт
 *   читал `input.handle`, которого в схеме нет, а память ключуется числом — handle из цели (строка) → Number.
 * - наведённая цель: куда последний раз кликнули/навели (act, input_click, ui_invoke). Печать «в фокус» (input_type,
 *   act type без цели, Ctrl+V) наследует её признаки поля (S-6). Сбрасывают её смена окна и уход фокуса (Tab/Enter).
 * - буфер обмена: последний `system_clipboard{write}` — вставка судится по его содержимому.
 *
 * Подписи и имена — данные ЭКРАНА: используются только в сторону «спросить/отказать», не как инструкции.
 */
import { keyClass, looksLikeSecretField } from "@jarvis/shared";

export interface HandleInfo {
  /** Имя элемента (без роли). */
  label: string;
  role?: string;
  secret: boolean;
}

/** Признаки поля наведённой цели (для печати в фокус). */
export interface AimedTarget {
  hints: string[];
  secret: boolean;
}

interface Mem {
  handles: Map<number, HandleInfo>;
  aimed?: AimedTarget;
  clipboard?: string;
}

const mems = new WeakMap<object, Mem>();
const HANDLES_MAX = 400;

function mem(session: object): Mem {
  let m = mems.get(session);
  if (!m) mems.set(session, (m = { handles: new Map() }));
  return m;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const asObj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** S-1: handle цели — `{by:"handle", handle:"41"}` (схема: строка), `{handle:"41"}` у act или число. Иначе undefined. */
export function targetHandle(target: unknown): number | undefined {
  const raw = typeof target === "number" || typeof target === "string" ? target : asObj(target)?.handle;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw.trim()) : NaN;
  return Number.isInteger(n) ? n : undefined;
}

function remember(m: Mem, it: Record<string, unknown>): void {
  const handle = targetHandle(it.handle);
  if (handle === undefined) return;
  const label = str(it.name).slice(0, 160);
  const role = str(it.role) || undefined;
  const secret = it.value === "•••" || looksLikeSecretField([label, str(it.automationId)]);
  if (!label && !role && !secret) return;
  m.handles.delete(handle); // свежая запись — в хвост (вытесняются самые старые)
  m.handles.set(handle, { label, ...(role ? { role } : {}), secret });
  if (m.handles.size > HANDLES_MAX) m.handles.delete(m.handles.keys().next().value as number);
}

/** handle → имя/роль/секрет из результата ui_snapshot ({items:[{handle,name,role,value,automationId}]}) или ui_ground. */
export function rememberUiHandles(session: object | undefined, data: unknown): void {
  const d = asObj(data);
  if (!session || !d) return;
  const m = mem(session);
  if (!Array.isArray(d.items)) {
    if (d.handle !== undefined) remember(m, d);
    return;
  }
  for (const it of d.items) {
    const o = asObj(it);
    if (o) remember(m, o);
  }
}

export function handleInfo(session: object | undefined, handle: unknown): HandleInfo | undefined {
  const h = targetHandle(handle);
  return session && h !== undefined ? mems.get(session)?.handles.get(h) : undefined;
}

/** Имя элемента по handle (только имя: так его судит подпись коммита). */
export function uiHandleLabel(session: object | undefined, handle: unknown): string | undefined {
  return handleInfo(session, handle)?.label || undefined;
}

/** Признаки поля из цели инструмента: строка act, {text,name,role,automationId}, handle → память. */
export function targetFacts(session: object | undefined, target: unknown): AimedTarget {
  if (typeof target === "string") return { hints: target.trim() ? [target.trim()] : [], secret: false };
  const t = asObj(target);
  if (!t) return { hints: [], secret: false };
  const hints = [t.text, t.name, t.role, t.automationId].map(str).filter(Boolean);
  const info = handleInfo(session, t.handle);
  if (info?.label) hints.push(info.label);
  return { hints, secret: info?.secret === true };
}

/** Клавиша уводит фокус из поля (Tab, Enter, Esc, коммит-сочетания) — наведённая цель больше не в фокусе. */
function movesFocus(combo: string): boolean {
  const cls = keyClass(combo);
  if (cls === "paste" || cls === "blocked" || cls === "autotype") return false;
  return cls !== "safe" || /(^|\+)\s*(tab|esc|escape)\s*$/iu.test(combo.trim());
}

/**
 * Эпилог dispatchTool: запомнить, куда навели (act/input_click/ui_invoke), что положили в буфер обмена и что
 * вернул ui_ground; сбросить наведённую цель при смене окна или уходе фокуса.
 */
export function noteGateTarget(session: object | undefined, name: string, input: Record<string, unknown>, data?: unknown): void {
  if (!session) return;
  const m = mem(session);
  if (name === "ui_ground") rememberUiHandles(session, data);
  if ((name === "act" && input.target !== undefined) || name === "input_click" || name === "ui_invoke") {
    m.aimed = targetFacts(session, input.target);
    return;
  }
  const combo = name === "input_key" ? str(input.combo) : name === "act" && input.do === "key" ? str(input.combo) : "";
  if (combo && movesFocus(combo)) m.aimed = undefined;
  const clickedElsewhere = name === "input_mouse" && (input.op === "down" || input.op === "drag");
  if (name === "app_focus" || name === "app_launch" || name === "window_focus" || clickedElsewhere) m.aimed = undefined;
  if (name === "system_clipboard" && str(input.op) === "write") m.clipboard = typeof input.text === "string" ? input.text : String(input.text ?? "");
}

export function aimedTarget(session: object | undefined): AimedTarget | undefined {
  return session ? mems.get(session)?.aimed : undefined;
}

export function lastClipboard(session: object | undefined): string | undefined {
  return session ? mems.get(session)?.clipboard : undefined;
}
