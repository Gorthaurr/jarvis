/**
 * Общие низкоуровневые примитивы CDP-плумбинга — вынесено из дублей `browser-cdp.ts` и
 * `jarvis-browser.ts` (§ревью, HIGH-дубль). Здесь только то, что было скопировано ОДИН-В-ОДИН:
 * интерфейс `WsLike`, резолвер конструктора WebSocket и ЧИСТЫЕ функции (сборка JSON-RPC кадра,
 * разбор ответа по id, разворачивание `Runtime.evaluate`). Stateful-логика (соединение, таймауты,
 * жизненный цикл дочернего Chrome, `readyState` vs `dead`) ОСТАЁТСЯ в каждом классе — она у них
 * законно разная, объединение добавило бы лишнюю связанность. Чистые функции → прямой юнит-тест.
 */
import NodeWebSocket from "ws";

/** Минимальный контракт WebSocket для CDP-клиентов (глобальный и пакет `ws` совместимы). */
export interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", cb: (ev: { data?: unknown }) => void): void;
  /** Есть у браузерного/`ws` WebSocket; необязателен (persistent-мини-клиент его не читает). */
  readyState?: number;
}

/**
 * Конструктор WebSocket: глобальный (Node 22+/renderer), иначе пакет `ws` (Electron main на Node 20.x,
 * где глобального WebSocket НЕТ). Без этого CDP молча откатывался на launch-only и невидимый путь не работал.
 */
export function resolveWebSocketCtor(): new (url: string) => WsLike {
  return (
    (globalThis as { WebSocket?: new (u: string) => WsLike }).WebSocket ??
    (NodeWebSocket as unknown as new (u: string) => WsLike)
  );
}

/** Один CDP-вызов (JSON-RPC). `params` опускаем, если пуст (как ждёт протокол). Чистая функция. */
export function cdpCommand(id: number, method: string, params?: Record<string, unknown>): Record<string, unknown> {
  return params ? { id, method, params } : { id, method };
}

/** Ответ CDP (на наш запрос) с числовым id. */
export interface CdpReply {
  id: number;
  result?: unknown;
  error?: { message?: string };
}

/**
 * Разобрать входящий CDP-кадр. Возвращает ответ, если это РЕАЛЬНЫЙ ответ с числовым id; иначе null
 * (событие без id, не-JSON-мусор) — вызывающий такие игнорирует. Чистая функция.
 */
export function parseCdpReply(data: string): CdpReply | null {
  let m: { id?: unknown; result?: unknown; error?: { message?: string } };
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof m.id !== "number") return null; // событие/уведомление, не ответ
  return { id: m.id, result: m.result, error: m.error };
}

/**
 * Развернуть результат `Runtime.evaluate` (returnByValue:true): вернуть value, бросить при
 * exceptionDetails (исключение в page-контексте). `errLabel` — префикс ошибки вызывающего. Чистая функция.
 */
export function unwrapEvalResult<T = unknown>(raw: unknown, errLabel: string): T {
  const r = raw as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
  if (r.exceptionDetails) throw new Error(`${errLabel}: ${r.exceptionDetails.text ?? "исключение"}`);
  return r.result?.value as T;
}
