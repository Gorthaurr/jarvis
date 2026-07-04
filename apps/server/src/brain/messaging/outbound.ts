/**
 * Оркестрация исходящих сообщений от лица пользователя (§14, UC-2).
 *
 * Поток: cadence guard (§14 анти-бан) → confirm с revise-петлёй (§14: «перепиши короче»
 * → перегенерация → новый confirm) → идемпотентность (retry не шлёт дубль) → отправка.
 *
 * Чистая оркестрация с инъекцией зависимостей — тестируется без сети/LLM/БД.
 * Сам `send` выполняет клиентский userbot (§12), отправитель инъектируется.
 */
import type { MessageChannel } from "@jarvis/protocol";
import type { CadenceGuard } from "./cadence.js";

export interface OutboundParams {
  userId: string;
  channel: MessageChannel;
  /** Резолвнутый адрес (id/username). */
  recipient: string;
  /** Черновик текста (может переписываться в revise-петле). */
  body: string;
  /** Писал ли когда-либо этому контакту (§14). */
  neverMessagedBefore: boolean;
}

export interface OutboundDeps {
  /** Запрос подтверждения у пользователя (§14). revision → перегенерация. */
  requestConfirm: (summary: string) => Promise<{ approved: boolean; revision?: string }>;
  /** Перегенерация текста по правке (§14 revise-петля). */
  regenerate: (revision: string, prevBody: string) => Promise<string>;
  cadence: CadenceGuard;
  /** Идемпотентность (§14): уже отправляли такой ключ? */
  isAlreadySent: (key: string) => boolean;
  markSent: (key: string) => void;
  /** Фактическая отправка (клиентский userbot, §12). */
  send: (channel: MessageChannel, recipient: string, body: string) => Promise<{ ok: boolean; error?: string }>;
  maxRevisions?: number;
  /** Задержка перед отправкой (§14 человеческий конверт). Инъекция для тестов; деф — реальный sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export type OutboundStatus = "sent" | "blocked" | "denied" | "duplicate" | "error";

export interface OutboundResult {
  status: OutboundStatus;
  body: string;
  reason?: string;
  messageKey?: string;
}

function idempotencyKey(p: { userId: string; channel: string; recipient: string; body: string }): string {
  let h = 5381;
  const s = `${p.userId}|${p.channel}|${p.recipient}|${p.body}`;
  for (let i = 0; i < s.length; i += 1) h = (h * 33) ^ s.charCodeAt(i);
  return `${p.channel}:${p.recipient}:${(h >>> 0).toString(36)}`;
}

export async function sendOutbound(params: OutboundParams, deps: OutboundDeps): Promise<OutboundResult> {
  // 1) Cadence guard (§14): rate-limit / веер / burst.
  const cad = deps.cadence.check({
    userId: params.userId,
    channel: params.channel,
    recipient: params.recipient,
    neverMessagedBefore: params.neverMessagedBefore,
  });
  if (!cad.allowed) {
    return { status: "blocked", body: params.body, reason: `cadence: ${cad.reason}` };
  }

  // 2) Confirm с revise-петлёй (§14). Новый контакт → confirm обязателен (cad.requiresConfirm).
  let body = params.body;
  const maxRev = deps.maxRevisions ?? 3;
  let approved = false;
  for (let rev = 0; rev <= maxRev; rev += 1) {
    const res = await deps.requestConfirm(`Отправляю ${params.recipient}: «${body}»`);
    if (res.approved) {
      approved = true;
      break;
    }
    if (res.revision) {
      body = await deps.regenerate(res.revision, body); // перегенерация → новый confirm
      continue;
    }
    return { status: "denied", body, reason: "пользователь отклонил" };
  }
  if (!approved) return { status: "denied", body, reason: "исчерпан лимит правок без подтверждения" };

  // 3) Идемпотентность (§14): дубль при retry не уходит.
  const key = idempotencyKey({ userId: params.userId, channel: params.channel, recipient: params.recipient, body });
  if (deps.isAlreadySent(key)) {
    return { status: "duplicate", body, reason: "уже отправлено (idempotency)", messageKey: key };
  }

  // 4) Человеческий конверт (§14): пауза перед отправкой, чтобы не палиться равномерной частотой.
  if (cad.suggestedDelayMs > 0) {
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    await sleep(cad.suggestedDelayMs);
  }

  // 5) Отправка через userbot (§12).
  const sent = await deps.send(params.channel, params.recipient, body);
  if (!sent.ok) return { status: "error", body, reason: sent.error ?? "ошибка отправки", messageKey: key };

  deps.markSent(key);
  deps.cadence.record(params.userId, params.channel, params.recipient);
  return { status: "sent", body, messageKey: key };
}
