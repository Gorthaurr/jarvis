/**
 * Сторонние зависимости лаборатории БЕЗ `pnpm install` (нельзя трогать node_modules боевого Джарвиса): берём то, что уже
 * лежит у клиента/сервера, через require от их package.json. Лаборатория — не член pnpm-workspace.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Абсолютный путь корня репозитория (с прямыми слэшами, без хвостового). */
export const ROOT: string = fileURLToPath(new URL("../../../", import.meta.url)).split("\\").join("/").replace(/\/$/u, "");
export const repoRoot = (...p: string[]): string => [ROOT, ...p].join("/");

const fromClient = createRequire(repoRoot("apps/client/package.json"));
const fromServer = createRequire(repoRoot("apps/server/package.json"));

/** Минимальная типизация `ws` (типы пакета лежат у клиента и из infra/lab не видны). */
export interface WsLike {
  readonly readyState: number;
  // biome-ignore lint/suspicious/noExplicitAny: обработчики ws принимают разные аргументы
  on(event: "open" | "close" | "error" | "message" | string, cb: (...args: any[]) => void): void;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}
export type WsCtor = (new (url: string, opts?: Record<string, unknown>) => WsLike) & { OPEN: number; CLOSED: number };

export const WebSocket: WsCtor = fromClient("ws");
export const requireFromServer: NodeRequire = fromServer;
export const requireFromClient: NodeRequire = fromClient;
