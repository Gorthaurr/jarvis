/**
 * Типы модели приложения FakeDesktop. Приложение — объект, привязанный к окну: строит UIA-узлы из своего состояния и
 * реагирует на нажатия/ввод, меняя `window.text`/`title` (это и видит eval по итоговому состоянию).
 */
import { canonicalKeyName } from "@jarvis/shared";
import type { DesktopWindow } from "../lib/contracts.js";
import type { DesktopCore } from "./core.js";
import type { GuiState, Rect } from "./gui-state.js";

export type { Rect };

/** Узел UIA до присвоения handle. Роль короткая («button»), в ground она превращается в «ControlType.Button». */
export interface NodeSpec {
  /** Стабильный внутри модели ключ узла. */
  id: string;
  role: string;
  name: string;
  /** Видимая подпись (для OCR): у кнопки калькулятора name «Пять», а на экране «5». "" — текста на экране нет. */
  label?: string;
  automationId?: string;
  value?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Попадает в ui.snapshot (set-of-marks) и может быть целью клика. */
  interactive: boolean;
}

export interface UiaNode extends NodeSpec {
  handle: number;
}

export interface PressOpts {
  button: "left" | "right" | "middle";
  count: number;
  /** UIA Invoke (бесшумно), а не физический клик: у строки списка Invoke = «открыть», клик = «выделить». */
  invoke: boolean;
}

export interface Ctx {
  core: DesktopCore;
  st: GuiState;
  /** Открыть приложение по имени (файл/каталог/URL как аргумент); возвращает окно. */
  open(app: string, arg?: string): DesktopWindow;
  /** Создать окно с готовой моделью (диалоги и вспомогательные окна приложений). */
  spawn(spec: SpawnSpec): DesktopWindow;
  /** Модель окна (создаётся по процессу при первом обращении — в том числе для окон из seed). */
  model(w: DesktopWindow): Model;
}

export interface SpawnSpec {
  process: string;
  /** Процесс-владелец: диалог живёт в pid приложения, а не в новом. */
  pid?: number;
  title: string;
  text?: string;
  rect?: Rect;
  monitor?: number;
  model?: (w: DesktopWindow) => Model;
}

export interface Model {
  kind: string;
  nodes(): NodeSpec[];
  /** id узла с фокусом клавиатуры (или null — фокус на «пустом» месте окна). */
  focusId(): string | null;
  press(id: string, o: PressOpts): void;
  /** ValuePattern.SetValue; у узла без значения — ошибка (как «паттерн не поддержан»). */
  setValue(id: string, value: string): void;
  /** Ввод символов в окно; false — некуда (фокус не на текстовом поле): нажатия ушли в пустоту. */
  type(text: string): boolean;
  /** Нажатие клавиши/комбо; false — окно на неё не реагирует. */
  key(combo: string): boolean;
  /** Клик по узлу переносит на него фокус клавиатуры (поле ввода). */
  focus(id: string): void;
  /** Выделенный текст (context.read selection, Ctrl+C). */
  selectedText(): string;
  /** Закрытие «крестиком» может быть отклонено (несохранённое): false — окно осталось, приложение спросило пользователя. */
  canClose?(): boolean;
}

/** Прямоугольник внутри клиентской области окна (под заголовком 32 px). */
export const CLIENT_TOP = 32;
export const at = (w: DesktopWindow, dx: number, dy: number, ww: number, hh: number): { x: number; y: number; w: number; h: number } => ({
  x: w.rect.x + dx,
  y: w.rect.y + CLIENT_TOP + dy,
  w: ww,
  h: hh,
});

/** Канонический разбор combo: модификаторы отдельно, основная клавиша в нижнем регистре. */
export function parseCombo(combo: string): { ctrl: boolean; alt: boolean; shift: boolean; win: boolean; key: string } {
  const c = combo.trim();
  // Основная клавиша «+» ("+" одиночно или "Ctrl++") не должна теряться при разбиении по «+».
  const plus = c === "+" || c.endsWith("++");
  const parts = (plus ? c.slice(0, -1) : c).split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const key = plus ? "+" : (parts.pop() ?? "");
  const mods = new Set(parts);
  // Имя клавиши — каноническое, как у гейта и расширения (Left = ArrowLeft, Esc = Escape); незнакомое (numpad*, add) — как есть.
  return { ctrl: mods.has("ctrl") || mods.has("control"), alt: mods.has("alt"), shift: mods.has("shift"), win: mods.has("win") || mods.has("meta"), key: canonicalKeyName(key) ?? key };
}
