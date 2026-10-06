import type { DesktopWindow } from "../lib/contracts.js";
import type { Model } from "./gui-model.js";
export type FrameKind = "f" | "z" | "o" | "s";

/** Кадр задачи: куда ложится его картинка в экранных координатах и сколько пикселей картинки на единицу экрана. */
export interface Frame {
  id: string;
  kind: FrameKind;
  monitor: number;
  origin: { x: number; y: number };
  sx: number;
  sy: number;
  w: number;
  h: number;
  zoomOf?: string;
}

export interface Selection {
  x: number;
  y: number;
  w: number;
  h: number;
  monitorIndex: number;
  createdAt: number;
  hash?: string;
}

export interface GuiState {
  epoch: unknown;
  frameSeq: number;
  frames: Map<string, Frame>;
  z: number[];
  cursor: { x: number; y: number };
  jarvisMonitor: number | null;
  monitorTarget: "jarvis" | "primary";
  selection: Selection | null;
  /** Заранее запланированный «владельцем» обвод области (userAction selection.plan): срабатывает в start{waitMs}. */
  plannedSelection: { x: number; y: number; w: number; h: number; monitorIndex: number; afterMs: number } | null;
  /** Вуаль режима выделения: владелец «рисует», физический ввод Джарвиса гейтится. */
  drawing: boolean;
  gsi: Map<string, { data: unknown; at: number }>;
  fileWatch: Map<string, { sig: string; since: number }>;
  held: Set<string>;
  /** Зажатая кнопка мыши (op:down без up): по up без сдвига это клик, со сдвигом — перетаскивание. */
  mouseDown: { x: number; y: number; button: string } | null;
  recording: boolean;
  /** Виртуальное время последнего ввода владельца (userAction input/mouse/keyboard): для USER_BUSY проактивных команд. */
  ownerInputAt: number;
  models: WeakMap<DesktopWindow, Model>;
}

export interface CoordSpace {
  space?: "screen";
  frame?: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
