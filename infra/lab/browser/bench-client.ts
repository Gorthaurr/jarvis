/**
 * Клиент dev-роутов лаб-сервера `/dev/bench/*` (JARVIS_DEV_HTTP=1, токен лаб-сервера): вызов инструмента через НАСТОЯЩИЙ
 * `dispatchTool` в долгоживущей bench-сессии, к которой подключено живое расширение (`ctx.ext` = мост, принявший /ext).
 * §14-вопросы владельцу отвечает политика вызова, а не человек; ActionCommand клиенту ПК здесь отказ (клиента нет).
 */
import type { LabServer } from "../lib/contracts.js";

export type ConfirmAnswer = "yes" | "no" | "expire" | "undelivered";

export interface BenchQuestion {
  n: number;
  kind: string;
  summary: string;
  answer: ConfirmAnswer;
  outcome: string;
  atMs: number;
  overflow?: boolean;
}

export interface BenchToolReply {
  ms: number;
  /** Что увидит модель: текст, флаги честности (sent/declined/uncertain/observed...), картинки как base64. */
  result: {
    isError: boolean;
    text: string;
    content: Array<{ type: "text"; text: string } | { type: "image"; mediaType: string; bytes: number; data: string }>;
    flags: Record<string, boolean | string>;
    data?: unknown;
  };
  /** Вопросы §14, заданные владельцу за этот вызов, и ответ политики. */
  questions: BenchQuestion[];
  policyOverflow: boolean;
  /** Что подставили вместо `$ref:`/`$match:`. */
  resolved: Record<string, string>;
  /** Команды клиенту ПК, которые инструмент пытался отправить (клиента нет — все отклонены). */
  clientActions: Array<{ kind: string; atMs: number }>;
  ext: { connected: boolean; waitedMs: number };
}

export interface BenchState {
  ext: { connected: boolean };
  session: { id: string; userId: string; dev: boolean } | null;
  busy: boolean;
  stray: Array<{ kind: string; summary: string; at: number }>;
}

async function benchFetch(server: LabServer, method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${server.httpUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-jarvis-dev-token": server.devToken },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(150_000),
  });
  const j = (await r.json()) as Record<string, unknown>;
  // ok:false — транспорт/ввод (занято, плейсхолдер не разрешён), не провал самого инструмента: тот виден в result.isError.
  if (!r.ok || j.ok === false) throw new Error(`${method} ${path}: ${r.status} ${String(j.error ?? "")}${j.unresolved ? ` (не разрешено: ${JSON.stringify(j.unresolved)})` : ""}`);
  return j;
}

export interface BenchToolOpts {
  /** Политика §14 на вызов: ответ или очередь ответов. По умолчанию "no": необратимое само не выполняется. */
  confirm?: ConfirmAnswer | ConfirmAnswer[];
  /** Сколько ждать коннекта расширения, мс (MV3 воркер засыпает и переподключается). */
  waitExtMs?: number;
}

export async function callBenchTool(server: LabServer, name: string, input: Record<string, unknown> = {}, o: BenchToolOpts = {}): Promise<BenchToolReply> {
  const j = await benchFetch(server, "POST", "/dev/bench/tool", { name, input, confirm: o.confirm ?? "no", waitExtMs: o.waitExtMs ?? 5_000 });
  return j as unknown as BenchToolReply;
}

export const benchState = async (server: LabServer): Promise<BenchState> => (await benchFetch(server, "GET", "/dev/bench/state")) as unknown as BenchState;

/** Снести bench-сессию: забываются цель вкладки, ref-подсказки, одобрения (чистый лист между сценариями). */
export const benchReset = async (server: LabServer): Promise<void> => void (await benchFetch(server, "POST", "/dev/bench/reset", {}));
