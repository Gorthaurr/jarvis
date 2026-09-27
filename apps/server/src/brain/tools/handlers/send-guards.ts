/**
 * Общие гарды ИСХОДЯЩИХ отправок (§14): confirm-once на адресата, cadence, окна идемпотентности, ресенд-гард,
 * сериализация per-user. Вынесено из handlers/messaging.ts (W2 П3: модуль не растёт) — потребители: messaging.ts
 * (telegram_send / голосовое / message_send / order_place) и mail.ts (реэкспорт из messaging.ts сохранён).
 */
import { AsyncMutex, TtlCache } from "@jarvis/shared";
import { approveSend, isSendApproved } from "../../consent.js";
import { CadenceGuard } from "../../messaging/cadence.js";
import { ResendGuard, resendGuardWindowMs } from "../../messaging/resend-guard.js";
import type { ConfirmOutcome, ToolContext } from "../dispatch.js";

/**
 * Подтверждение отправки адресату ОДИН РАЗ (§14, фидбэк пользователя). Если этого адресата уже одобряли
 * когда-либо (в т.ч. в прошлой сессии — согласие персистентно) — не переспрашиваем. Иначе спрашиваем;
 * чистое одобрение запоминаем НАВСЕГДА (ревизия текста согласие не фиксирует).
 */
export async function confirmSendOnce(
  ctx: ToolContext,
  channel: string,
  recipient: string,
  summary: string,
): Promise<ConfirmOutcome> {
  if (isSendApproved(ctx.userId, channel, recipient)) {
    return { approved: true, outcome: "approved" };
  }
  // Ф0: канала подтверждения нет вовсе → это НЕ отказ владельца, а невозможность его спросить.
  if (!ctx.confirm) return { approved: false, outcome: "undelivered" };
  const r = await ctx.confirm(summary, "send");
  if (r.approved) await approveSend(ctx.userId, channel, recipient);
  return r;
}

/**
 * Ф0 пульта: РАЗНЫЕ слова на разные исходы. Раньше любой неуспех звучал как «вы не подтвердили» —
 * то есть Джарвис утверждал, что владелец ПРИНЯЛ РЕШЕНИЕ, хотя тот мог вопроса вовсе не видеть
 * (мёртвый сокет, закрытая сессия) или не успеть ответить. Приписывать владельцу чужое решение —
 * та же ложь, что «Готово» без результата.
 */
export function sendGateMessage(outcome: ConfirmOutcome["outcome"], what: string, to: string, repeat = false): string {
  const act = repeat ? `повторную отправку ${what}` : `отправку ${what}`;
  switch (outcome) {
    case "undelivered":
      return `Не отправил ${what} «${to}» — не смог спросить вашего подтверждения: связь с вашим экраном была недоступна.`;
    case "expired":
      return `Не отправил ${what} «${to}» — вы не ответили на подтверждение, и оно истекло. Скажите, если отправить.`;
    default:
      return `Не отправил ${what} — вы не подтвердили ${act} «${to}».`;
  }
}

/** Cadence/идемпотентность переписки — на процесс (per-user внутри, §14). */
export const cadence = new CadenceGuard();
// Аудит-2 [8]: дедуп отправки — ОКНО, а не «навсегда». Прежний Set<string> без TTL/eviction: (а) блокировал
// ЛЕГИТИМНЫЙ повтор той же фразы тому же адресату НАВСЕГДА («напиши маме 'еду домой'» назавтра не уходил);
// (б) рос без ограничения на долгоживущем сервере. TtlCache даёт окно дедупа (анти-retry burst) + eviction.
const SEND_DEDUP_MS = Math.max(30_000, Number(process.env.JARVIS_SEND_DEDUP_MS) || 10 * 60_000);
export const sentKeys = new TtlCache<true>({ ttlMs: SEND_DEDUP_MS, maxEntries: 2000 });
/** Идемпотентность заказов — окно (§14; аудит-2 [8]). */
export const placedOrderKeys = new TtlCache<true>({ ttlMs: SEND_DEDUP_MS, maxEntries: 2000 });
/**
 * Ресенд-гард (эпизод «двойная отправка Кате» 2026-07-24): короткое окно «этому человеку только что
 * уже уходило сообщение». Ловит то, что упускает точная идемпотентность: повтор с другой пунктуацией/
 * регистром/склонением имени. Адресат помнится под ВСЕМИ ключами идентичности (peerId + имя + стем).
 * ЛЕНИВО (ревью: .env грузится в index.ts ПОСЛЕ ESM-хойст-импортов — module-load читал бы дефолт,
 * игнорируя JARVIS_RESEND_GUARD_MS; та же грабля, что device у эмбеддера).
 */
let _resendGuard: ResendGuard | undefined;
export function resendGuard(): ResendGuard {
  _resendGuard ??= new ResendGuard(resendGuardWindowMs());
  return _resendGuard;
}
/** Только для тестов: пересоздать гард (подхватить env текущего теста). */
export function _resetResendGuardForTest(): void {
  _resendGuard = undefined;
}

/**
 * Сериализация исходящих ПЕР-ПОЛЬЗОВАТЕЛЬ (ревью: две параллельные задачи проходили check ресенд-гарда
 * ДО record друг друга → обе слали без единого confirm). Мьютекс делает «check → confirm → send →
 * record» атомарным относительно других отправок того же пользователя; отправки редки — очередь дёшева.
 */
const sendLocks = new Map<string, AsyncMutex>();
export function sendLock(userId: string): AsyncMutex {
  let m = sendLocks.get(userId);
  if (!m) {
    m = new AsyncMutex();
    sendLocks.set(userId, m);
  }
  return m;
}

/** Человекочитаемое «N с назад» для сводки confirm/ответа модели (нет возраста — честное «недавно»). */
export function agoOf(ageMs: number | undefined): string {
  return ageMs === undefined ? "недавно" : `${Math.max(1, Math.round(ageMs / 1000))} с назад`;
}

