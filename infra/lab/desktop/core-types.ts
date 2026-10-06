import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import type { DesktopEffect, DesktopSeed, DesktopSnapshot, DesktopWindow } from "../lib/contracts.js";
export type ErrCode = NonNullable<ActionResult["error"]>["code"];

export interface Monitor {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  dpi: number;
  primary: boolean;
}

export interface AudioSession {
  pid: number;
  name: string;
  volume: number;
  muted: boolean;
}

export type KindHandler = (cmd: ActionCommand, meta: { commandId: string; timeoutMs: number }) => Promise<ActionResult> | ActionResult;
export type KindHandlers = Partial<Record<ActionCommand["kind"], KindHandler>>;

/** Виртуальная ФС песочницы: ключ — нормализованный путь (прямые слэши, регистр как задан, диск в верхнем регистре). */
export interface VirtualFs {
  /** Корень домашней папки «владельца», напр. "C:/Users/lab". */
  home: string;
  files: Map<string, Buffer>;
  dirs: Set<string>;
}

export interface DesktopCore {
  /** Виртуальное время (мс), стартует с 0; `advance` двигает. Реальные таймеры не используются. */
  now(): number;
  advance(ms: number): void;

  windows: Map<number, DesktopWindow>;
  foreground: number | null;
  nextHwnd(): number;
  nextPid(): number;
  monitors: Monitor[];

  fs: VirtualFs;
  clipboard: string;
  volume: number;
  muted: boolean;
  media: { playing: boolean; title?: string };
  locked: boolean;
  audioSessions: AudioSession[];
  installedApps: Set<string>;
  /** Сеть для невидимого браузера/поиска: URL → текст. */
  web: Map<string, string>;

  effects: DesktopEffect[];
  effect(kind: string, detail?: Record<string, unknown>): void;
  listeners: Set<(e: DesktopEffect) => void>;

  /** Успешный результат. */
  ok(commandId: string, data?: unknown, extra?: Partial<Pick<ActionResult, "stepIndex" | "durationMs">>): ActionResult;
  /** Честная ошибка (как у настоящего клиента: not_found / denied / runtime / timeout ...). */
  fail(commandId: string, code: ErrCode, message: string, data?: unknown): ActionResult;

  snapshot(): DesktopSnapshot;
  reset(seed?: DesktopSeed): void;
}
