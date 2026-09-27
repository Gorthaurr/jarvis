// Сигнатуры page-функций реестра ref (исходник — ref.js; исполняются в ИЗОЛИРОВАННОМ мире своим toString()).
import type { PageFail } from "./types.js";

export interface ViewportInfo {
  ok: true;
  /** Вьюпорт в CSS px и devicePixelRatio. */
  w: number;
  h: number;
  dpr: number;
  /** Прямоугольник цели по ref в CSS px относительно вьюпорта (элемент вне экрана прокручен в центр). */
  rect?: { x: number; y: number; w: number; h: number };
}

/** Пометить элемент ref атрибутом data-jarvis-act=nonce (мост в MAIN для robustClickMain{nonce}). */
export function stampRefIsolated(localRef: string, nonce: string): { ok: true } | PageFail;
/** Вьюпорт и (по ref) прямоугольник цели для снимка; ref устарел — ref_stale, без размера — capture_failed. */
export function captureTargetIsolated(localRef?: string | null): Promise<ViewportInfo | PageFail>;
/** Играет ли медиа страницы (ground truth); пусто — неизвестно. */
export function readMediaStateIsolated(): { playing?: boolean };
/** Какие из ref устарели (другой документ / элемент отсоединён). */
export function validateRefsIsolated(localRefs: readonly string[]): { bad: string[] };
