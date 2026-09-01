/**
 * ФОЛБЭК-ЦЕПОЧКА мозга (волна G, 2026-08-31): основной канал — Messages API по ключу; когда он
 * недоступен (кончился кредит, лимит, сеть), ход уходит на РЕЗЕРВНЫЙ канал — подписку Max через
 * Agent SDK (subscription-llm.ts). Раньше в этом месте владелец получал стаб «связь прервалась»
 * и полностью терял ассистента, хотя оплаченная подписка простаивала.
 *
 * КАК УЗНАЁМ, ЧТО ОСНОВНОЙ КАНАЛ НЕ СРАБОТАЛ (без переписывания anthropic.ts): его провайдер по
 * дизайну НЕ бросает наружу — он возвращает `stubbed:true, stopReason:"stub"` после ретраев или
 * на неретраябельной 4xx (в т.ч. «credit balance is too low»). Этот признак и есть наш триггер:
 * он ловит ВСЕ причины отказа одинаково, а различать «деньги кончились» и «сеть моргнула» для
 * переключения не нужно.
 *
 * ЗАКОН ЧЕСТНОСТИ (главное здесь):
 *  • Резерв пробуется, только если он РЕАЛЬНО доступен (`live`) — иначе отдаём стаб основного,
 *    как раньше; никаких обещаний работы по каналу, которого нет.
 *  • Если упали ОБА — возвращается стаб (stopReason:"stub"), и вся защита петли (H2: стаб = провал
 *    хода, задача НЕ финалится успехом, семантический кэш не пишется) продолжает работать.
 *  • Переключение видно в логах и метриках: `channel:"subscription"` — владелец должен понимать,
 *    почему поведение/скорость изменились, и что он сейчас тратит лимиты подписки, а не API.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import type { ILlmProvider, LlmDelta, LlmRequest, LlmResponse } from "./llm.js";
import { lastSubscriptionFailure } from "./subscription-llm.js";

const log: Logger = createLogger("llm:fallback");

/** Куда ушёл ход — для наблюдаемости (метрики/лог). */
export type LlmChannel = "primary" | "subscription";

export interface FallbackLlmDeps {
  /** Колбэк наблюдаемости: вызывается при КАЖДОМ переключении на резерв. */
  onFallback?: (info: { reason: string }) => void;
}

/**
 * Проверочный режим: гнать ВСЕ ходы сразу через подписку, минуя основной канал
 * (`JARVIS_FORCE_SUBSCRIPTION=1`). Нужен, чтобы владелец мог убедиться, что резерв реально работает,
 * не дожидаясь исчерпания ключа; в боевом режиме выключен — резерв активируется только при отказе.
 */
function forceSubscription(): boolean {
  return process.env.JARVIS_FORCE_SUBSCRIPTION === "1";
}

/**
 * Сколько подряд отказов основного канала считаем «он мёртв надолго» и на сколько перестаём его
 * дёргать. Мотив — СКОРОСТЬ: при исчерпанном кредите каждый ход тратил секунды на обречённый
 * HTTP-запрос с ретраем ПЕРЕД тем, как уйти в резерв (замер: это ощутимая доля времени ответа).
 * Предохранитель полуоткрытый: по истечении паузы основной пробуется снова — пополнение баланса
 * подхватывается само, без перезапуска.
 */
const TRIP_AFTER_FAILURES = 2;
function breakerCooldownMs(): number {
  const raw = Number(process.env.JARVIS_PRIMARY_COOLDOWN_MS ?? 300_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 300_000;
}

export class FallbackLlmProvider implements ILlmProvider {
  /** Живой, если жив хотя бы один канал (иначе стаб-режим, как и раньше). */
  readonly live: boolean;
  /** Канал последнего успешного хода — читают метрики/диагностика. */
  lastChannel: LlmChannel = "primary";
  private consecutiveFailures = 0;
  private skipPrimaryUntil = 0;

  constructor(
    private readonly primary: ILlmProvider,
    private readonly secondary: ILlmProvider,
    private readonly deps: FallbackLlmDeps = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.live = primary.live || secondary.live;
  }

  /** Стоит ли вообще пробовать основной канал сейчас (предохранитель + наличие ключа). */
  private primaryWorthTrying(): boolean {
    if (!this.primary.live) return false;
    if (this.skipPrimaryUntil === 0) return true;
    if (this.now() < this.skipPrimaryUntil) return false;
    // Пауза истекла — пробуем снова (полуоткрытое состояние): вдруг баланс пополнили.
    this.skipPrimaryUntil = 0;
    this.consecutiveFailures = 0;
    log.info("основной канал: пауза истекла — пробую снова");
    return true;
  }

  /** Учесть исход основного канала: серия отказов → пауза, успех → сброс. */
  private notePrimary(ok: boolean): void {
    if (ok) {
      if (this.consecutiveFailures > 0 || this.skipPrimaryUntil > 0) log.info("основной канал снова отвечает — предохранитель снят");
      this.consecutiveFailures = 0;
      this.skipPrimaryUntil = 0;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= TRIP_AFTER_FAILURES && this.secondary.live && breakerCooldownMs() > 0) {
      this.skipPrimaryUntil = this.now() + breakerCooldownMs();
      log.warn("основной канал отказал подряд — временно иду сразу в резерв (экономлю секунды на ход)", {
        failures: this.consecutiveFailures,
        cooldownMs: breakerCooldownMs(),
      });
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (forceSubscription()) return this.viaSubscription(req, "принудительная проверка резерва", () => this.primary.complete(req));
    const tryPrimary = this.primaryWorthTrying();
    const first = tryPrimary ? await this.primary.complete(req) : undefined;
    if (first) this.notePrimary(!first.stubbed);
    if (first && !first.stubbed) {
      this.lastChannel = "primary";
      return first;
    }
    const reason = first
      ? "основной канал вернул стаб (кредит/лимит/сеть)"
      : this.primary.live
        ? "основной канал на паузе после отказов"
        : "основной канал недоступен (нет ключа)";
    return this.viaSubscription(req, reason, () => first ?? stubOf(req, this.primary));
  }

  async completeStream(req: LlmRequest, onDelta: (d: LlmDelta) => void): Promise<LlmResponse> {
    // 🔴 Стрим и фолбэк: дельты, уже отданные наружу, «отыграть» нельзя (двойной голос). Поэтому на
    // основном канале сначала пробуем БЕЗ выдачи наружу — копим локально и отдаём одним куском, если
    // ход удался. Так переключение на резерв остаётся возможным без риска озвучить два ответа.
    if (forceSubscription()) {
      return this.viaSubscription(req, "принудительная проверка резерва", () => this.primary.complete(req), onDelta);
    }
    let acc = "";
    const tryPrimary = this.primaryWorthTrying();
    const first = tryPrimary ? await this.primary.completeStream(req, (d) => (acc += d.text)) : undefined;
    if (first) this.notePrimary(!first.stubbed);
    if (first && !first.stubbed) {
      this.lastChannel = "primary";
      if (acc) onDelta({ text: acc });
      return first;
    }
    const reason = first
      ? "основной канал вернул стаб (кредит/лимит/сеть)"
      : this.primary.live
        ? "основной канал на паузе после отказов"
        : "основной канал недоступен (нет ключа)";
    return this.viaSubscription(req, reason, () => first ?? stubOf(req, this.primary), onDelta);
  }

  /** Ход через подписку; при её недоступности/падении — честный стаб основного канала. */
  private async viaSubscription(
    req: LlmRequest,
    reason: string,
    fallbackStub: () => Promise<LlmResponse> | LlmResponse,
    onDelta?: (d: LlmDelta) => void,
  ): Promise<LlmResponse> {
    if (!this.secondary.live) {
      log.warn("основной канал недоступен, резерв по подписке НЕ настроен — стаб", { reason });
      return fallbackStub();
    }
    log.warn("переключаюсь на РЕЗЕРВНЫЙ канал — подписка", { reason });
    this.deps.onFallback?.({ reason });
    try {
      const raw = onDelta ? await this.secondary.completeStream(req, onDelta) : await this.secondary.complete(req);
      // Канал проставляем ЗДЕСЬ, а не полагаемся на провайдера: по нему петля решает, начислять ли
      // долларовую стоимость (подписка оплачена помесячно — см. LlmResponse.channel).
      const resp: LlmResponse = { ...raw, channel: "subscription" };
      this.lastChannel = "subscription";
      log.info("ход выполнен по подписке", { tier: req.tier, toolUses: resp.toolUses.length, outputTokens: resp.usage.outputTokens });
      return resp;
    } catch (e) {
      // Резерв тоже не смог (протухший токен, лимит подписки, сбой CLI) — отдаём стаб основного:
      // петля обязана увидеть провал хода, а не «пустой успех».
      log.error("резервный канал (подписка) не сработал — стаб", { error: e instanceof Error ? e.message : String(e) });
      return withKnownReason(await fallbackStub());
    }
  }
}

/**
 * 🔴 Если ОБА канала легли, а причина известна — владелец должен услышать ЕЁ (2026-09-01, живая
 * проверка: кредиты API исчерпаны + OAuth-сессия подписки протухла). Прежде он слышал «связь
 * прервалась» и повторял фразу снова и снова, не догадываясь, что нужно переавторизоваться:
 * система ЗНАЛА причину и молчала — та же нечестность, что «Готово» без результата.
 * Стаб остаётся стабом (`stubbed:true`, ход провален) — меняется только текст.
 */
function withKnownReason(stub: LlmResponse): LlmResponse {
  const failure = lastSubscriptionFailure();
  if (!failure || !stub.stubbed) return stub;
  const what =
    failure.kind === "auth"
      ? "Сэр, я не могу связаться с моделью: доступ по подписке разлогинился. Нужно выполнить claude setup-token и обновить токен в настройках."
      : failure.kind === "credits"
        ? "Сэр, я не могу связаться с моделью: и оплаченный ключ, и лимит подписки исчерпаны. Пока их не пополнить, отвечать я не смогу."
        : failure.kind === "rate_limit"
          ? "Сэр, модель ограничивает частоту запросов — основной канал тоже недоступен. Попробуем через несколько минут."
          : `Сэр, связи с моделью нет: ${failure.human}`;
  return { ...stub, text: what };
}

/** Стаб основного провайдера (когда его даже не звали — нет ключа). */
async function stubOf(req: LlmRequest, primary: ILlmProvider): Promise<LlmResponse> {
  // У мёртвого основного `complete` сам возвращает стаб — используем его же формулировку,
  // чтобы текст «связь прервалась» был один на всю систему (не плодим вторую версию фразы).
  return primary.complete(req);
}
