/**
 * Хендлеры ИСХОДЯЩИХ сообщений/заказов (§14) — вынесено из god-object dispatch.ts (§ревью).
 * telegram_send (невидимый CDP + расширение-фолбэк), telegram_send_voice, message_send (vk/telegram через
 * outbound-гард), order_place (red-line карты §0). Общие send-гарды (confirm-once + cadence + идемпотентность)
 * живут здесь, рядом с потребителями. Маршрутизация остаётся в dispatch (switch).
 */
import { DEFAULT_ACTION_TIMEOUT_MS, type MessageChannel } from "@jarvis/protocol";
import { AsyncMutex, TtlCache, nameSearchVariants } from "@jarvis/shared";
import { approveSend, isSendApproved } from "../../consent.js";
import { CadenceGuard } from "../../messaging/cadence.js";
import { idempotencyKey, sendOutbound } from "../../messaging/outbound.js";
import { ResendGuard, peerIdentityKeys, resendGuardWindowMs } from "../../messaging/resend-guard.js";
import { CardDataError, DEFAULT_ORDER_POLICY, type OrderItem } from "../../orders/order-guard.js";
import { placeOrder } from "../../orders/orders.js";
import type { ConfirmOutcome, ToolContext, ToolResult } from "../dispatch.js";
import { channelDownResult, confirmDeclineText, declined, err, ok } from "../dispatch-util.js";

/**
 * Подтверждение отправки адресату ОДИН РАЗ (§14, фидбэк пользователя). Если этого адресата уже одобряли
 * когда-либо (в т.ч. в прошлой сессии — согласие персистентно) — не переспрашиваем. Иначе спрашиваем;
 * чистое одобрение запоминаем НАВСЕГДА (ревизия текста согласие не фиксирует).
 */
async function confirmSendOnce(
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
function sendGateMessage(outcome: ConfirmOutcome["outcome"], what: string, to: string): string {
  switch (outcome) {
    case "undelivered":
      return `Не отправил ${what} «${to}» — не смог спросить вашего подтверждения: связь с вашим экраном была недоступна.`;
    case "expired":
      return `Не отправил ${what} «${to}» — вы не ответили на подтверждение, и оно истекло. Скажите, если отправить.`;
    default:
      return `Не отправил ${what} — вы не подтвердили отправку «${to}».`;
  }
}

/** Cadence/идемпотентность переписки — на процесс (per-user внутри, §14). */
const cadence = new CadenceGuard();
// Аудит-2 [8]: дедуп отправки — ОКНО, а не «навсегда». Прежний Set<string> без TTL/eviction: (а) блокировал
// ЛЕГИТИМНЫЙ повтор той же фразы тому же адресату НАВСЕГДА («напиши маме 'еду домой'» назавтра не уходил);
// (б) рос без ограничения на долгоживущем сервере. TtlCache даёт окно дедупа (анти-retry burst) + eviction.
const SEND_DEDUP_MS = Math.max(30_000, Number(process.env.JARVIS_SEND_DEDUP_MS) || 10 * 60_000);
const sentKeys = new TtlCache<true>({ ttlMs: SEND_DEDUP_MS, maxEntries: 2000 });
/** Идемпотентность заказов — окно (§14; аудит-2 [8]). */
const placedOrderKeys = new TtlCache<true>({ ttlMs: SEND_DEDUP_MS, maxEntries: 2000 });
/**
 * Ресенд-гард (эпизод «двойная отправка Кате» 2026-07-24): короткое окно «этому человеку только что
 * уже уходило сообщение». Ловит то, что упускает точная идемпотентность: повтор с другой пунктуацией/
 * регистром/склонением имени. Адресат помнится под ВСЕМИ ключами идентичности (peerId + имя + стем).
 * ЛЕНИВО (ревью: .env грузится в index.ts ПОСЛЕ ESM-хойст-импортов — module-load читал бы дефолт,
 * игнорируя JARVIS_RESEND_GUARD_MS; та же грабля, что device у эмбеддера).
 */
let _resendGuard: ResendGuard | undefined;
function resendGuard(): ResendGuard {
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
function sendLock(userId: string): AsyncMutex {
  let m = sendLocks.get(userId);
  if (!m) {
    m = new AsyncMutex();
    sendLocks.set(userId, m);
  }
  return m;
}

/** Человекочитаемое «N с назад» для сводки confirm/ответа модели (нет возраста — честное «недавно»). */
function agoOf(ageMs: number | undefined): string {
  return ageMs === undefined ? "недавно" : `${Math.max(1, Math.round(ageMs / 1000))} с назад`;
}

/** Проблема резолва адресата (не транспорт): не нашёл/неоднозначно/не залогинен. */
function isResolveIssue(msg: string): boolean {
  return /\[tg-resolve\]|не залогинен/i.test(msg);
}
/** Убрать служебный маркер «[tg-resolve]» перед показом модели. */
function stripResolveMarker(msg: string): string {
  return msg.replace(/\[tg-resolve\]\s*/g, "").trim();
}
/** Достать имя чата из data результата (CDP/расширение возвращают chatTitle/matched). */
function chatTitleOf(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as { chatTitle?: unknown; matched?: unknown };
  const t = (typeof d.chatTitle === "string" && d.chatTitle) || (typeof d.matched === "string" && d.matched) || "";
  return String(t).trim();
}

/**
 * Невидимая отправка в Telegram (§6). ОСНОВНОЙ путь — клиентский выделенный Chrome + CDP (telegram.send):
 * окно за экраном, реальный webK, доставка подтверждается исходящим пузырём. Расширение — fallback при сбое CDP.
 */
export async function telegramSend(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const lock = sendLock(ctx.userId);
  await lock.acquire();
  try {
    return await telegramSendLocked(ctx, input);
  } finally {
    lock.release();
  }
}

async function telegramSendLocked(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const to = String(input.to ?? "").trim();
  const text = String(input.text ?? "").trim();
  // §P1-тёзки (ревью р1): peerId ВЫБРАННОГО владельцем кандидата — задаётся после ответа «ТЁЗКИ, id=…».
  // Точный peer открывает чат в обход резолва по имени → разрывает дедлок короткого имени, которое носят
  // несколько людей. Прежний alias-механизм откачен: он ОБХОДИЛ namesake-гейт (fast-path openHinted) и
  // травил память точного ключа (CRITICAL-находки ревью).
  const peer = String(input.peer ?? "").trim();
  // §14 ресенд: TRUE только когда пользователь ЯВНО просит отправить ПОВТОРНО — включает confirm-путь
  // вместо молчаливого дедуп-блока (модель сама флаг не «пробивает»: без подтверждения повтор не уйдёт).
  const resend = input.resend === true;
  if (!to || !text) return err("telegram_send: нужны to и text");
  // M6: cadence-гард — тот же механизм, что message_send (анти-бан/анти-веер/анти-burst).
  const cad = cadence.check({ userId: ctx.userId, channel: "telegram", recipient: to, neverMessagedBefore: false });
  if (!cad.allowed) return err(`Не отправил «${to}»: cadence-лимит (${cad.reason}).`);
  // ОПЫТНАЯ ПАМЯТЬ (§ скорость): помним, как резолвили этого адресата → клиент откроет чат СРАЗУ.
  // §P1-тёзки: явный peer (выбор владельца из списка тёзок) ГЛАВНЕЕ памяти — точный peerId в обход
  // резолва по имени; память при этом НЕ читаем (стейл-связка короткого имени не должна перебить
  // явный выбор — CRITICAL-находка) и на успехе НЕ переписываем ключ to (короткое имя многозначно,
  // память по нему снова увела бы не туда). Резолв поднят ВЫШЕ гардов: peerId нужен ресенд-гарду
  // как ключ идентичности адресата («Катя»/«Кате» — один человек).
  const hint = peer ? undefined : ctx.resolutionMemory?.recall(ctx.userId, "telegram", to);
  const hintPeerId = peer || hint?.peerId;
  // M6: идемпотентность — ОКНО дедупа (аудит-2 [8]): rapid-повтор УСПЕШНО доставленной фразы в окне
  // SEND_DEDUP_MS не уходит второй раз. ⚠️ Доставленная-но-истёкшая-по-таймауту отправка ключ НЕ ставит
  // (только на result.ok) → в этом окне возможен дубль — открытый tradeoff [9] (нужна delivery-confirmation).
  // Ключ по ТОЧНОЙ идентичности адресата, когда она известна (контрольное ревью: имя-ключ у тёзок общий —
  // отправка ВТОРОЙ Кате с явным peer ложно билась бы об окно первой; peer/hintPeerId различают людей).
  const key = idempotencyKey({ userId: ctx.userId, channel: "telegram", recipient: peer || hintPeerId || to, body: text });
  // Ресенд-гард (эпизод 2026-07-24): этому же человеку только что уже уходило сообщение? При ЯВНОМ
  // peer (владелец выбрал из тёзок) идентичность ТОЧНАЯ — сверяем только peer-ключ, а не имя/стем
  // (иначе отправка ВТОРОЙ Кате ложно билась бы об окно первой — ревью).
  const checkKeys = peer ? [`peer:${peer}`] : peerIdentityKeys({ peerId: hintPeerId, names: [to] });
  const recent = resendGuard().check(ctx.userId, "telegram", checkKeys, text);
  const identicalHit = sentKeys.get(key) !== undefined || recent?.kind === "identical";
  // §14: отправка — критичное действие. Обычный путь — confirm ОДИН раз на адресата (дальше помним
  // навсегда). Повтор/вдогонку в коротком окне — ЯВНЫЙ confirm на КАЖДЫЙ случай (консент адресата
  // его не заменяет: дубль человеку — необратим, цена ложного «да» выше одного вопроса).
  let confirmedByResendGate = false;
  if (identicalHit || recent) {
    if (identicalHit && !resend) {
      return ok(
        `Уже отправлял «${to}» то же самое ${agoOf(recent?.ageMs)} — повтор НЕ ушёл. ` +
          `Если пользователь ЯВНО просит отправить ещё раз — повтори вызов с resend:true (уйдёт после подтверждения).`,
      );
    }
    if (!ctx.confirm) return err(`Повторная отправка «${to}» требует подтверждения (§14), а канал подтверждения недоступен.`);
    const preview = `${text.slice(0, 160)}${text.length > 160 ? "…" : ""}`;
    const summary = identicalHit
      ? `Повторная отправка «${to}» в Telegram (то же сообщение уже уходило ${agoOf(recent?.ageMs)}):\n${preview}`
      : `«${to}» только что (${agoOf(recent?.ageMs)}) получил: «${recent!.prev.bodyPreview}».\nОтправить вдогонку ещё и это?\n${preview}`;
    const c = await ctx.confirm(summary, "send");
    if (!c.approved) return ok(`Не отправил — вы не подтвердили повторную отправку «${to}».`);
    confirmedByResendGate = true;
    // Чистое «да» с показом адресата и текста — это и есть согласие §14 на адресата: фиксируем.
    await approveSend(ctx.userId, "telegram", to);
  }
  if (!confirmedByResendGate) {
    const gate = await confirmSendOnce(ctx, "telegram", to, `Отправить «${to}» в Telegram?\n${text.slice(0, 160)}${text.length > 160 ? "…" : ""}`);
    if (!gate.approved) return declined(sendGateMessage(gate.outcome, "сообщение", to));
  }
  // ⚠️ Ревью р2 (peer-канал был МЁРТВ): клиентский fast-path (openHinted по peerId) входит ТОЛЬКО при
  // непустом preferredTitle. При явном peer подаём preferredTitle=to — иначе fast-path пропускался,
  // hintPeerId выбрасывался, и резолв снова упирался в тёзок (дедлок). openHinted приоритизирует peerId
  // над именем → откроет ТОЧНО выбранного, а to служит лишь фолбэком поиска, если peer протух.
  const preferredTitle = hint?.title ?? (peer ? to : undefined);
  const result = await ctx.session.sendAction({ kind: "telegram.send", to, text, preferredTitle, hintPeerId }, 90_000);
  if (result.ok) {
    const data = result.data as { chatTitle?: string; peerId?: string } | undefined;
    const who = chatTitleOf(result.data) || to; // называем РЕАЛЬНОГО адресата (мог отличаться: Герман→Herman)
    // Память пишем ТОЛЬКО когда to резолвился однозначно (без явного peer): при peer «to» — короткое
    // многозначное имя, запоминать его → выбранный чат небезопасно (следующий раз снова не та Катя).
    if (data?.chatTitle && !peer) ctx.resolutionMemory?.remember(ctx.userId, "telegram", to, { peerId: data.peerId, title: data.chatTitle });
    sentKeys.set(key, true);
    cadence.record(ctx.userId, "telegram", to);
    // Ресенд-гард: помним отправку под ВСЕМИ ключами идентичности (peerId + запрошенное имя + реальный
    // чат + стемы склонений) — следующая отправка «тому же человеку под другим написанием» увидится.
    resendGuard().record(ctx.userId, "telegram", peerIdentityKeys({ peerId: data?.peerId || hintPeerId, names: [to, who] }), text);
    return { ...ok(`Отправлено «${who}» в Telegram.`), sent: true };
  }
  // Б4 (интеграционное ревью #4): канал ПК мёртв (resume-grace) — команда не ушла. Основной CDP-путь
  // недоступен; фолбэк на расширение идёт через ОТДЕЛЬНЫЙ /ext-сокет (может быть жив), поэтому пробуем
  // его; но если фолбэка нет/тоже не вышел — помечаем channelDown (петля ждёт reconnect, не эскалирует).
  const wasChannelDown = !result.ok && result.error?.code === "channel_down";
  const rawReason = result.error?.message ?? "ошибка";
  const reason = stripResolveMarker(rawReason);
  // self-heal: вели по памяти, но резолв не вышел → запомненное устарело → забываем.
  if (hint && isResolveIssue(rawReason)) ctx.resolutionMemory?.forget(ctx.userId, "telegram", to);
  // Проблема РЕЗОЛВА (не нашёл/неоднозначно/не залогинен) — НЕ транспортный сбой: отдаём модели без фолбэка.
  if (isResolveIssue(rawReason)) return err(reason);
  // Иначе — транспортный сбой CDP-пути: пробуем расширение (те же транслит-варианты для recall).
  if (ctx.telegramSend) {
    try {
      const out = await ctx.telegramSend(to, text, nameSearchVariants(to));
      const who = chatTitleOf(out) || to;
      sentKeys.set(key, true);
      cadence.record(ctx.userId, "telegram", to);
      resendGuard().record(ctx.userId, "telegram", peerIdentityKeys({ peerId: hintPeerId, names: [to, who] }), text);
      return { ...ok(`Отправлено «${who}» в Telegram (через расширение).`), sent: true };
    } catch (e) {
      const em = stripResolveMarker(e instanceof Error ? e.message : String(e));
      // Фолбэк тоже не вышел, а исходно был channel_down → петля пусть ждёт reconnect (не эскалирует).
      if (wasChannelDown) {
        const cd = channelDownResult(result, "telegram_send не отправлен: канал с ПК недоступен (переподключение).");
        if (cd) return cd;
      }
      return err(`Не удалось отправить в Telegram: ${reason}; расширение: ${em}`);
    }
  }
  // Фолбэка нет и канал ПК мёртв → channelDown (не эскалируем тир на транспортном сбое).
  const cd = channelDownResult(result, "telegram_send не отправлен: канал с ПК недоступен (переподключение).");
  if (cd) return cd;
  return err(`Не удалось отправить в Telegram: ${reason}`);
}

/**
 * §: ГОЛОСОВОЕ в Telegram голосом филиппа. Синтез TTS (synthVoice) → mp3 base64 → расширение записывает
 * его в web.telegram как голосовое (подмена микрофона). Гейт §14 — как у telegram_send (confirm на адресата).
 */
export async function telegramSendVoiceHandler(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const lock = sendLock(ctx.userId);
  await lock.acquire();
  try {
    return await telegramSendVoiceLocked(ctx, input);
  } finally {
    lock.release();
  }
}

async function telegramSendVoiceLocked(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const to = String(input.to ?? "").trim();
  const text = String(input.text ?? "").trim();
  if (!to || !text) return err("telegram_send_voice: нужны to и text (что произнести голосом)");
  if (!ctx.synthVoice || !ctx.telegramSendVoice) return err("Голосовые недоступны: нет TTS или расширение не подключено.");
  // Эпизод 2026-07-24: голосовые шли МИМО cadence и ресенд-гарда (дыра того же класса «двойная
  // отправка», только модальностью голосового) — теперь те же гарды, что у текстового telegram_send.
  const cad = cadence.check({ userId: ctx.userId, channel: "telegram", recipient: to, neverMessagedBefore: false });
  if (!cad.allowed) return err(`Не отправил голосовое «${to}»: cadence-лимит (${cad.reason}).`);
  const guardKeys = peerIdentityKeys({ names: [to] });
  const recent = resendGuard().check(ctx.userId, "telegram", guardKeys, text);
  if (recent) {
    if (!ctx.confirm) return err(`Повторная отправка «${to}» требует подтверждения (§14), а канал подтверждения недоступен.`);
    const c = await ctx.confirm(
      `«${to}» только что (${agoOf(recent.ageMs)}) получал: «${recent.prev.bodyPreview}».\nОтправить ещё и ГОЛОСОВОЕ:\n«${text.slice(0, 160)}${text.length > 160 ? "…" : ""}»?`,
      "send",
    );
    if (!c.approved) return ok(`Не отправил голосовое — вы не подтвердили повтор «${to}».`);
    await approveSend(ctx.userId, "telegram", to);
  } else {
    const gate = await confirmSendOnce(ctx, "telegram", to, `Отправить ГОЛОСОВОЕ «${to}» (голос филиппа)?\n«${text.slice(0, 160)}${text.length > 160 ? "…" : ""}»`);
    if (!gate.approved) return declined(sendGateMessage(gate.outcome, "голосовое", to));
  }
  try {
    const audioB64 = await ctx.synthVoice(text); // mp3 base64 голосом филиппа
    await ctx.telegramSendVoice(to, audioB64);
    cadence.record(ctx.userId, "telegram", to);
    resendGuard().record(ctx.userId, "telegram", guardKeys, text);
    return { ...ok(`Отправил голосовое «${to}» голосом филиппа.`), sent: true };
  } catch (e) {
    return err(`Не вышло отправить голосовое «${to}»: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** message.send под гардами §14: confirm (revise-петля) + cadence + idempotency (UC-2). */
export async function messageSend(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const lock = sendLock(ctx.userId);
  await lock.acquire();
  try {
    return await messageSendLocked(ctx, input);
  } finally {
    lock.release();
  }
}

async function messageSendLocked(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.confirm) return err("отправка недоступна: нет канала подтверждения (§14)");
  const channel = input.channel as MessageChannel;
  const to = String(input.to ?? "").trim();
  const body = String(input.body ?? "").trim();
  const resend = input.resend === true; // §14 ресенд: явная просьба пользователя повторить (см. telegram_send)
  if (channel !== "vk" && channel !== "telegram") return err("message_send: неизвестный channel");
  if (!to || !body) return err("message_send: нужны to и body");

  // Ресенд-гард (эпизод 2026-07-24) — тем же контрактом, что telegram_send: повтор молчаливо не
  // уходит (подсказка про resend:true), повтор/вдогонку по явной просьбе — только через confirm.
  const guardKeys = peerIdentityKeys({ names: [to] });
  const recent = resendGuard().check(ctx.userId, channel, guardKeys, body);
  let confirmedByResendGate = false;
  if (recent) {
    if (recent.kind === "identical" && !resend) {
      return ok(
        `Уже отправлял «${to}» то же самое ${agoOf(recent.ageMs)} — повтор НЕ ушёл. ` +
          `Если пользователь ЯВНО просит отправить ещё раз — повтори вызов с resend:true (уйдёт после подтверждения).`,
      );
    }
    const preview = `${body.slice(0, 160)}${body.length > 160 ? "…" : ""}`;
    const summary = recent.kind === "identical"
      ? `Повторная отправка «${to}» (${channel}) — то же сообщение уже уходило ${agoOf(recent.ageMs)}:\n${preview}`
      : `«${to}» только что (${agoOf(recent.ageMs)}) получил: «${recent.prev.bodyPreview}».\nОтправить вдогонку ещё и это?\n${preview}`;
    const c = await ctx.confirm(summary, "send");
    if (!c.approved) return ok(`Не отправил — вы не подтвердили повторную отправку «${to}».`);
    confirmedByResendGate = true;
    await approveSend(ctx.userId, channel, to);
  }
  // Явный resend при хите ТОЛЬКО длинного окна точной идемпотентности (ресенд-окно уже истекло, а
  // sentKeys ещё держит): тоже confirm-путь — иначе подтверждённый повтор упёрся бы в duplicate.
  if (resend && !confirmedByResendGate) {
    const preKey = idempotencyKey({ userId: ctx.userId, channel, recipient: to, body });
    if (sentKeys.get(preKey) !== undefined) {
      const c = await ctx.confirm(
        `Повторная отправка «${to}» (${channel}) — то же сообщение уже уходило недавно:\n${body.slice(0, 160)}${body.length > 160 ? "…" : ""}`,
        "send",
      );
      if (!c.approved) return ok(`Не отправил — вы не подтвердили повторную отправку «${to}».`);
      confirmedByResendGate = true;
      await approveSend(ctx.userId, channel, to);
    }
  }

  let channelDown = false; // Б4 (интеграционное ревью #4): код channel_down теряется в обёртке — ловим сами
  const res = await sendOutbound(
    { userId: ctx.userId, channel, recipient: to, body, neverMessagedBefore: true },
    {
      // §14: подтверждаем адресата один раз, дальше помним навсегда (как telegram_send). Ресенд-гейт
      // уже показал владельцу адресата и ТОЧНЫЙ текст → второй вопрос подряд не задаём.
      requestConfirm: confirmedByResendGate
        ? async () => ({ approved: true, outcome: "approved" as const })
        : (summary: string) => confirmSendOnce(ctx, channel, to, summary),
      regenerate: async (_rev, prev) => prev, // полная перегенерация — через новый ход агента
      cadence,
      // Явный ПОДТВЕРЖДЁННЫЙ повтор обязан уйти — точный дедуп-ключ его не блокирует.
      isAlreadySent: (k) => (resend && confirmedByResendGate ? false : sentKeys.get(k) !== undefined),
      markSent: (k) => sentKeys.set(k, true),
      send: async (ch, rcpt, b) => {
        const r = await ctx.session.sendAction({ kind: "message.send", channel: ch, to: rcpt, body: b }, DEFAULT_ACTION_TIMEOUT_MS);
        if (r.error?.code === "channel_down") channelDown = true;
        return { ok: r.ok, error: r.error?.message };
      },
    },
  );
  if (res.status === "sent") {
    resendGuard().record(ctx.userId, channel, guardKeys, res.body);
    return { ...ok(`Отправлено ${to}.`), sent: true };
  }
  // Точный дедуп сработал (окно sentKeys) — это НЕ ошибка исполнения: честно объясняем модели, как
  // выглядит ЯВНЫЙ повтор (симметрично telegram_send; err тут провоцировал бессмысленные ретраи).
  if (res.status === "duplicate") {
    return ok(
      `Уже отправлял «${to}» то же самое недавно — повтор НЕ ушёл. ` +
        `Если пользователь ЯВНО просит отправить ещё раз — повтори вызов с resend:true (уйдёт после подтверждения).`,
    );
  }
  if (channelDown) {
    const cd = channelDownResult({ ok: false, error: { code: "channel_down" } }, "message_send не отправлен: канал с ПК недоступен (переподключение).");
    if (cd) return cd;
  }
  // Ф0 пульта (адверс-ревью HIGH): §14-гейт не пропустил — это НЕ сбой инструмента. Говорим исходом
  // владельца (не «пользователь отклонил» на всё подряд) и возвращаем declined, а не err: иначе
  // недоставленный вопрос кормил бы anti-runaway и эскалацию тира «от транспорта».
  if (res.status === "denied" && res.confirmOutcome !== undefined) {
    return declined(sendGateMessage(res.confirmOutcome, "сообщение", to));
  }
  return err(`Не отправлено (${res.status}): ${res.reason ?? ""}`);
}

/** order.place под гардами §14 + красная линия карты §0 (UC-5). */
export async function orderPlace(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.confirm) return err("заказ недоступен: нет канала подтверждения (§14)");
  const vendor = String(input.vendor ?? "").trim();
  const items = (Array.isArray(input.items) ? input.items : []) as OrderItem[];
  const total = Number(input.total ?? 0);
  if (!vendor || items.length === 0) return err("order_place: нужны vendor и items");
  let channelDown = false; // Б4 (интеграционное ревью #4): channel_down теряется в обёртке — ловим сами
  try {
    const res = await placeOrder({ userId: ctx.userId, vendor, items, total }, DEFAULT_ORDER_POLICY, {
      requestConfirm: (summary: string) => ctx.confirm!(summary, "order"), // Ф0: исход НЕ срезаем
      isAlreadyPlaced: (k) => placedOrderKeys.get(k) !== undefined,
      markPlaced: (k) => placedOrderKeys.set(k, true),
      place: async (req) => {
        const r = await ctx.session.sendAction(
          { kind: "order.place", vendor: req.vendor, items: req.items as unknown as Record<string, unknown>[], total: req.total },
          DEFAULT_ACTION_TIMEOUT_MS,
        );
        if (r.error?.code === "channel_down") channelDown = true;
        return { ok: r.ok, error: r.error?.message, orderId: (r.data as { orderId?: string })?.orderId };
      },
    });
    if (res.status === "placed") return { ...ok(`Заказ оформлен в «${vendor}» на ${total}.`), sent: true };
    if (channelDown) {
      const cd = channelDownResult({ ok: false, error: { code: "channel_down" } }, "order_place не отправлен: канал с ПК недоступен (переподключение).");
      if (cd) return cd;
    }
    if (res.status === "denied" && res.confirmOutcome !== undefined) {
      return declined(confirmDeclineText(res.confirmOutcome, "заказ"));
    }
    return err(`Заказ не оформлен (${res.status}): ${res.reason ?? ""}`);
  } catch (e) {
    if (e instanceof CardDataError) return err(e.message); // §0: красная линия карты
    throw e;
  }
}
