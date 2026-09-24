/**
 * ФОЛБЭК-ЦЕПОЧКА мозга (волна G, 2026-08-31): основной канал — Messages API по ключу; когда он
 * недоступен (кончился кредит, лимит, сеть), ход уходит на РЕЗЕРВНЫЙ канал — подписку Max через
 * Agent SDK (subscription-llm.ts). Раньше в этом месте владелец получал стаб «связь прервалась»
 * и полностью терял ассистента, хотя оплаченная подписка простаивала.
 *
 * КАК УЗНАЁМ, ЧТО ОСНОВНОЙ КАНАЛ НЕ СРАБОТАЛ (без переписывания anthropic.ts): его провайдер по
 * дизайну НЕ бросает наружу — он возвращает `stubbed:true, stopReason:"stub"` после ретраев или
 * на неретраябельной 4xx (в т.ч. «credit balance is too low»). Этот признак и есть наш триггер.
 *
 * 🔴 ДВА КЛАССА ОТКАЗА, А НЕ ОДИН (2026-09-02, разбор логов; владелец: «надо правильно вырубать API,
 * а не долбить его всё время»). Прежде ЛЮБОЙ отказ лечился одинаково: пауза 5 минут → полуоткрытая
 * проба → снова два обречённых HTTP-запроса. При исчерпанном балансе это давало 15 заведомо мёртвых
 * вызовов за день, лишние секунды на ход и 101 строку «переключаюсь на резерв» в логе — шум, за
 * которым не видно настоящих событий. Теперь:
 *   • ТЕРМИНАЛЬНЫЙ отказ (`credits` — кончился баланс, `auth` — ключ не принят) повтором НЕ лечится,
 *     пока владелец не вмешается → канал ВЫКЛЮЧАЕТСЯ (`off`) с ОДНИМ честным WARN. Больше ни одного
 *     запроса: перепроверка редкая (JARVIS_PRIMARY_RECHECK_MS, деф 6 ч; 0 = никогда) плюс одна проба
 *     после перезапуска — этого хватает, чтобы пополненный баланс подхватился сам, без ручной возни.
 *   • ТРАНЗИЕНТНЫЙ (сеть, 429, перегруз) — прежний полуоткрытый предохранитель на 5 минут.
 * Класс берём из `lastApiFailure()` (anthropic.ts уже классифицирует ошибку) и ТОЛЬКО если причина
 * записана ПОСЛЕ начала нашего вызова: протухшая причина прошлого сбоя не имеет права выключать канал.
 *
 * ЗАКОН ЧЕСТНОСТИ (главное здесь):
 *  • Резерв пробуется, только если он РЕАЛЬНО доступен (`live`) — иначе отдаём стаб основного,
 *    как раньше; никаких обещаний работы по каналу, которого нет.
 *  • Выключаем основной канал ТОЛЬКО при живом резерве: без резерва выключать не в пользу чего —
 *    мы обязаны продолжать звонить и держать причину отказа свежей, из неё собирается честная фраза
 *    владельцу («кончился баланс»), а не общее «связь прервалась».
 *  • Если упали ОБА — возвращается стаб (stopReason:"stub"), и вся защита петли (H2: стаб = провал
 *    хода, задача НЕ финалится успехом, семантический кэш не пишется) продолжает работать.
 *  • Состояние канала видно снаружи (`channelStatus()`): паспорт возможностей говорит модели, что
 *    основной канал выключен и почему — чтобы Джарвис не обещал скорость, которой сейчас нет.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { type ApiFailureKind, lastApiFailure, llmFailureLine } from "./anthropic.js";
import type { ILlmProvider, LlmChannelStatus, LlmDelta, LlmRequest, LlmResponse } from "./llm.js";
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
 * ЯВНЫЙ выключатель основного канала (`JARVIS_PRIMARY_LLM=0`): владелец знает, что ключа нет или он
 * не нужен, — и мы не трогаем API вообще, ни одной пробой. Отличается от FORCE_SUBSCRIPTION тем, что
 * это про КАНАЛ («API выключен»), а не про проверку резерва: смысл читается в логах и в паспорте.
 */
function primaryEnabledByEnv(): boolean {
  const raw = (process.env.JARVIS_PRIMARY_LLM ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "off" || raw === "false" || raw === "no");
}

/**
 * Сколько подряд отказов основного канала считаем «он мёртв надолго» и на сколько перестаём его
 * дёргать. Мотив — СКОРОСТЬ: каждый ход тратил секунды на обречённый HTTP-запрос с ретраем ПЕРЕД
 * тем, как уйти в резерв. Предохранитель полуоткрытый: по истечении паузы основной пробуется снова.
 * Это путь для ТРАНЗИЕНТНЫХ сбоев; терминальные (баланс/ключ) идут своим путём — см. шапку.
 */
const TRIP_AFTER_FAILURES = 2;
function breakerCooldownMs(): number {
  // Пустая строка → дефолт (та же грабля, что у terminalRecheckMs: Number("") === 0 обнулял бы
  // паузу и возвращал обречённые вызовы каждым ходом).
  const raw = (process.env.JARVIS_PRIMARY_COOLDOWN_MS ?? "").trim();
  if (!raw) return 300_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 300_000;
}

/** Отказы, которые повтором НЕ лечатся: нужно действие владельца (пополнить баланс / поправить ключ). */
const TERMINAL_KINDS: ReadonlySet<ApiFailureKind> = new Set<ApiFailureKind>(["credits", "auth"]);

/**
 * Через сколько перепроверить ВЫКЛЮЧЕННЫЙ канал (мс). Деф 6 часов: «не долбить» — но и не требовать
 * от владельца ручного включения после пополнения баланса. 0 — не перепроверять вовсе (до рестарта).
 */
function terminalRecheckMs(): number {
  // 🔴 Пустая строка в .env (`JARVIS_PRIMARY_RECHECK_MS=`) — это НЕ «никогда»: `??` ловит только
  // undefined, а Number("") === 0. Владелец, стерев значение, молча выключал бы перепроверку.
  // «Никогда» — только явный 0 (как обещает .env.example).
  const raw = (process.env.JARVIS_PRIMARY_RECHECK_MS ?? "").trim();
  if (!raw) return 6 * 3_600_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 6 * 3_600_000;
}

/** Как часто напоминать в лог, что идём по резерву (первый раз — всегда, дальше сводкой). */
const SWITCH_LOG_EVERY_MS = 10 * 60_000;

export class FallbackLlmProvider implements ILlmProvider {
  /** Живой, если жив хотя бы один канал (иначе стаб-режим, как и раньше). */
  readonly live: boolean;
  /** Канал последнего успешного хода — читают метрики/диагностика. */
  lastChannel: LlmChannel = "primary";
  private consecutiveFailures = 0;
  private skipPrimaryUntil = 0;
  /** Терминальный латч: канал выключен до `until` (0 = до перезапуска/успешной перепроверки). */
  private primaryOff?: { kind: ApiFailureKind; human: string; since: number; until: number };
  /** Сводка «сколько ходов подряд идём по резерву» — чтобы не писать WARN на каждый раунд. */
  private fallbackRounds = 0;
  private lastSwitchLogAt = 0;

  constructor(
    private readonly primary: ILlmProvider,
    private readonly secondary: ILlmProvider,
    private readonly deps: FallbackLlmDeps = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.live = primary.live || secondary.live;
  }

  /** Стоит ли вообще пробовать основной канал сейчас (ключ + выключатель + предохранители). */
  private primaryWorthTrying(): boolean {
    if (!this.primary.live) return false;
    if (!primaryEnabledByEnv()) return false;
    if (this.primaryOff) {
      // «Никогда» (until=0) или срок ещё не вышел — молча идём в резерв, ни одного запроса.
      if (this.primaryOff.until === 0 || this.now() < this.primaryOff.until) return false;
      log.info("основной канал: срок перепроверки настал — пробую снова", {
        kind: this.primaryOff.kind,
        выключенМин: Math.round((this.now() - this.primaryOff.since) / 60_000),
      });
      this.primaryOff = undefined;
      this.consecutiveFailures = 0;
      this.skipPrimaryUntil = 0;
      return true;
    }
    if (this.skipPrimaryUntil === 0) return true;
    if (this.now() < this.skipPrimaryUntil) return false;
    // Пауза истекла — пробуем снова (полуоткрытое состояние): вдруг сеть починилась.
    this.skipPrimaryUntil = 0;
    this.consecutiveFailures = 0;
    log.info("основной канал: пауза истекла — пробую снова");
    return true;
  }

  /**
   * Учесть исход основного канала. `wallStart` — Date.now() ПЕРЕД вызовом: по нему проверяем, что
   * причина отказа записана ЭТИМ вызовом, а не осталась от прошлого сбоя (иначе протухшая причина
   * выключила бы живой канал). Часы здесь настоящие — `lastApiFailure().at` тоже ставится Date.now().
   */
  private notePrimary(ok: boolean, wallStart: number): void {
    if (ok) {
      if (this.consecutiveFailures > 0 || this.skipPrimaryUntil > 0 || this.primaryOff) {
        log.info("основной канал снова отвечает — предохранитель снят");
      }
      this.consecutiveFailures = 0;
      this.skipPrimaryUntil = 0;
      this.primaryOff = undefined;
      this.fallbackRounds = 0;
      this.lastSwitchLogAt = 0;
      return;
    }
    // Терминальный класс (баланс/ключ) — выключаем канал, а не «пауза и снова стучимся». Только при
    // живом резерве: без него мы обязаны продолжать звонить, иначе потеряем и работу, и свежую причину.
    const failure = lastApiFailure();
    if (failure && failure.at >= wallStart && TERMINAL_KINDS.has(failure.kind) && this.secondary.live) {
      if (!this.primaryOff) {
        const recheck = terminalRecheckMs();
        this.primaryOff = {
          kind: failure.kind,
          human: failure.human,
          since: this.now(),
          until: recheck > 0 ? this.now() + recheck : 0,
        };
        log.warn("основной канал (API по ключу) ВЫКЛЮЧЕН — повтором это не лечится, работаю по подписке", {
          причина: failure.kind,
          что: failure.human,
          лечение: failure.kind === "credits" ? "пополнить баланс Anthropic API" : "поправить ANTHROPIC_API_KEY",
          перепроверкаЧерезМин: recheck > 0 ? Math.round(recheck / 60_000) : "никогда (до перезапуска)",
        });
      }
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

  /** Состояние каналов для паспорта возможностей (модель должна знать, чем сейчас работает). */
  channelStatus(): LlmChannelStatus {
    const subscriptionLive = this.secondary.live;
    // Проверочный режим тоже означает «основной канал не работает» — иначе паспорт скажет «ok», а
    // ходы будут идти медленным резервом, и модель не предупредит владельца о темпе.
    if (forceSubscription()) {
      return { primary: "off", kind: "forced", human: "все ходы принудительно идут по подписке", subscriptionLive };
    }
    if (!this.primary.live) return { primary: "off", kind: "no_key", human: "ключ API не задан", subscriptionLive };
    if (!primaryEnabledByEnv()) {
      return { primary: "off", kind: "disabled", human: "основной канал выключен настройкой", subscriptionLive };
    }
    if (this.primaryOff) return { primary: "off", kind: this.primaryOff.kind, human: this.primaryOff.human, subscriptionLive };
    if (this.skipPrimaryUntil > 0 && this.now() < this.skipPrimaryUntil) {
      return { primary: "cooldown", kind: "transient", human: "основной канал временно не отвечает", subscriptionLive };
    }
    return { primary: "ok", subscriptionLive };
  }

  /** W2: сессии держит резерв (подписка); основной канал сессий не имеет. */
  release(sessionKey: string): void {
    this.secondary.release?.(sessionKey);
    this.primary.release?.(sessionKey);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (forceSubscription()) return this.viaSubscription(req, "принудительная проверка резерва", () => localStub());
    const wallStart = Date.now();
    const tryPrimary = this.primaryWorthTrying();
    const first = tryPrimary ? await this.primary.complete(req) : undefined;
    if (first) this.notePrimary(!first.stubbed, wallStart);
    if (first && !first.stubbed) {
      this.lastChannel = "primary";
      return first;
    }
    return this.viaSubscription(req, this.switchReason(first), () => first ?? localStub());
  }

  async completeStream(req: LlmRequest, onDelta: (d: LlmDelta) => void): Promise<LlmResponse> {
    // 🔴 W0 (2026-09-09): дельты основного канала ПРОБРАСЫВАЮТСЯ СРАЗУ. Версия волны G копила их в буфер и
    // отдавала одним куском ПОСЛЕ завершения генерации — ради переключения на резерв без «двойного голоса».
    // Цена: первое слово = полная генерация; замеренный 29.07 выигрыш пофразного стрима был обнулён на всём
    // API-канале. Компромисс: резерв пробуем, только если основной отказал ДО первой дельты; отказ ПОСЛЕ
    // выдачи дельт — честный стаб (как было до волны G), двойного голоса нет.
    if (forceSubscription()) {
      return this.viaSubscription(req, "принудительная проверка резерва", () => localStub(), onDelta);
    }
    let emitted = false;
    const wallStart = Date.now();
    const tryPrimary = this.primaryWorthTrying();
    const first = tryPrimary
      ? await this.primary.completeStream(req, (d) => {
          if (d.text) emitted = true;
          onDelta(d);
        })
      : undefined;
    if (first) this.notePrimary(!first.stubbed, wallStart);
    if (first && !first.stubbed) {
      this.lastChannel = "primary";
      return first;
    }
    if (first && emitted) {
      log.warn("основной канал оборвался ПОСЛЕ выдачи дельт — резерв не пробуем (двойной голос), ход честно провален");
      return withKnownReason(first);
    }
    return this.viaSubscription(req, this.switchReason(first), () => first ?? localStub(), onDelta);
  }

  /** Почему ход уходит в резерв — одна формулировка на оба пути (была дублем в complete/stream). */
  private switchReason(first: LlmResponse | undefined): string {
    if (first) return "основной канал вернул стаб (кредит/лимит/сеть)";
    if (!this.primary.live) return "основной канал недоступен (нет ключа)";
    if (!primaryEnabledByEnv()) return "основной канал выключен настройкой JARVIS_PRIMARY_LLM";
    if (this.primaryOff) return `основной канал выключен: ${this.primaryOff.human}`;
    return "основной канал на паузе после отказов";
  }

  /**
   * Лог переключения. РАНЬШЕ печатался WARN на КАЖДЫЙ раунд (101 строка за день при мёртвом ключе) —
   * шум, в котором тонут настоящие события. Теперь: первый раз всегда, дальше сводка раз в 10 минут.
   * Колбэк наблюдаемости при этом зовётся на каждый ход — метрики ничего не теряют.
   */
  private noteSwitch(reason: string): void {
    this.fallbackRounds += 1;
    const t = this.now();
    if (this.lastSwitchLogAt === 0) {
      log.warn("иду по РЕЗЕРВНОМУ каналу — подписка", { reason });
      this.lastSwitchLogAt = t;
      return;
    }
    if (t - this.lastSwitchLogAt >= SWITCH_LOG_EVERY_MS) {
      log.info("продолжаю работать по подписке", { reason, ходовПодряд: this.fallbackRounds });
      this.lastSwitchLogAt = t;
    }
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
    this.noteSwitch(reason);
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

/**
 * Честный стаб БЕЗ обращения к сети.
 *
 * 🔴 Адверс-ревью 2026-09-02: раньше здесь звался `primary.complete(req)` — «у мёртвого основного он
 * сам вернёт стаб». Премисса верна ТОЛЬКО когда ключа нет (`live===false`). Но мы зовём этот путь и
 * когда основной канал ЖИВ, а пропущен осознанно (терминальный латч, пауза предохранителя,
 * `JARVIS_PRIMARY_LLM=0`) — и тогда выключенный канал получал реальный HTTP-запрос на КАЖДОМ ходе,
 * где не сработал резерв. Хуже того, при `JARVIS_PRIMARY_LLM=0` без резерва API отвечал по-настоящему,
 * и его ответ уходил владельцу как «стаб»: выключатель не выключал ничего.
 * Формулировка остаётся ОДНА на всю систему — `llmFailureLine()` (тот же текст, что у стаба
 * anthropic.ts), поэтому вторая версия фразы не заводится.
 */
function localStub(): LlmResponse {
  return {
    text: llmFailureLine(),
    toolUses: [],
    stopReason: "stub",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    stubbed: true,
  };
}
