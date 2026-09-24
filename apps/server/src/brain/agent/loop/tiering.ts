// W3 «Петля»: тир и модель: потолок по каналу, quality-эскалация, family-boost/executor, §7-лестница, трейдинг.
import { log, TRADING_TOOLS } from "./util.js";
import type { LoopCtx } from "./context.js";
import type { LoopState } from "./state.js";
import type { LoopConfig } from "./config.js";
import type { AgentDeps } from "../types.js";
import type { RoundResult } from "./tool-round.js";
import type { RoundSummary } from "./round-classify.js";
import type { Tier } from "@jarvis/shared";
import type { LlmResponse } from "../../../integrations/llm.js";

export interface TierCore { deps: AgentDeps; st: LoopState; cfg: LoopConfig }

export function makeTierHelpers(core: TierCore) {
  const { deps, st } = core;
  const { loopMaxBaseMs } = core.cfg;
  /**
   * 🔴 ПОТОЛОК ЗАВИСИТ ОТ КАНАЛА (решение владельца 2026-09-02: «отдельное решение на время
   * подписки»). 240 с калиброваны под ОСНОВНОЙ канал: там раунд с prompt-кешем §15 стоит доли
   * секунды. У резерва кеша нет вовсе, и ЗАМЕР по логу дня даёт медиану 4.9 с и p90 14.9 с НА РАУНД —
   * те же 22 шага GUI-задачи физически не влезают в 240 с и умирают на середине («время вышло,
   * сделал двадцать два шага»). Один потолок для каналов, отличающихся на порядок, — не «защита»,
   * а гарантированный обрыв.
   * Считаем ФУНКЦИЕЙ, а не один раз на старте: канал выясняется ПЕРВЫМ обращением к модели, и после
   * перезапуска сервера первая же задача иначе получала бы узкий потолок; плюс канал может
   * переключиться посреди длинной задачи. Множитель применяется ТОЛЬКО когда основной реально
   * выключен (`channelStatus`), а не «на всякий случай».
   */
  const loopMaxMs = (): number => {
    if (deps.llm.channelStatus?.().primary !== "off") return loopMaxBaseMs;
    const raw = Number.parseFloat(process.env.JARVIS_SUBSCRIPTION_TASK_X ?? "");
    const k = Number.isFinite(raw) && raw >= 1 && raw <= 5 ? raw : 2;
    return Math.min(1_800_000, Math.round(loopMaxBaseMs * k));
  };
  // QUALITY-ЭСКАЛАЦИЯ (аудит окружения 2026-07-21): §7-каскад эскалирует на Opus ТОЛЬКО failure-gated
  // (весь раунд провалился ×2). Недо-ТЩАТЕЛЬНОСТЬ без ошибок инструментов (модель «закрыла» задачу
  // поверхностно, не сверив исход или не достигнув цели) до Opus НЕ доходила → корень жалобы «не
  // заёбывается». Этот хелпер поднимает тир на сильный по КАЧЕСТВЕННОМУ сигналу (повторный промах
  // сверки / преждевременное «готово» vs цель) — сильная модель верифицирует и доводит лучше. Липкая
  // эскалация (перекрывает family-boost), executor-даунгрейд её не спускает (strongLocked). Идемпотентна.
  const escalateForQuality = (reason: string): void => {
    if (st.tier.currentTier === "fable" || deps.models.fable === st.tier.model) return; // уже на сильной (или тиры схлопнуты)
    st.tier.escalatedFrom = st.tier.escalatedFrom ?? { tier: st.tier.currentTier, model: st.tier.model };
    st.tier.currentTier = "fable";
    st.tier.model = deps.models.fable;
    st.tier.familyBoost = null;
    st.tier.strongLocked = true; // осознанная сила — executor вниз не спускает
    log.info("§quality-эскалация: недо-тщательность → сильная модель", { reason, tier: st.tier.currentTier });
  };
  return { loopMaxMs, escalateForQuality };
}

export function adjustTierBeforeCall(ctx: LoopCtx): void {
  const { tier, st, recalled } = ctx;
  const { executorDownshiftEnabled } = ctx.cfg;
  // §скорость: family-boost исчерпан (раунд переосмысления прошёл) → откат на прежний тир.
  // Если тем временем эскалировал КТО-ТО ЕЩЁ (trading-инструменты и т.п.) — не трогаем: откат
  // делаем только из того же fable, в который сами поднимали.
  if (st.tier.familyBoost) {
    if (st.tier.familyBoost.roundsLeft > 0) {
      st.tier.familyBoost.roundsLeft -= 1;
    } else {
      if (st.tier.currentTier === "fable") {
        st.tier.currentTier = st.tier.familyBoost.tier;
        st.tier.model = st.tier.familyBoost.model;
        log.info("family-boost исчерпан — откат на прежний тир (§скорость)", { tier: st.tier.currentTier });
      }
      st.tier.familyBoost = null;
    }
  }
  // §Волна3 (3.2) EXECUTOR-СТУПЕНЬ ВНИЗ: §7-эскалация раньше была липкой до конца задачи — вся
  // оставшаяся МЕХАНИКА (клики по известной процедуре) ехала на Opus в 2-3× медленнее/дороже.
  // Теперь: эскалированная §7 задача с ИЗВЕСТНОЙ процедурой (recall) после ≥2 ЧИСТЫХ раундов
  // подряд возвращается на прежний дешёвый тир — репланинг при новом провале снова эскалирует
  // штатным §7 (это и есть planner↔executor). Гейты: НЕ trading/анти-капитуляция (strongLocked —
  // там сила выбрана осознанно), одна попытка на задачу (анти-пинг-понг: свитч модели = перезапись
  // кеш-префикса), выкл JARVIS_EXECUTOR_TIER=0.
  if (
    executorDownshiftEnabled &&
    st.tier.escalatedFrom &&
    !st.tier.executorReverted &&
    !st.tier.strongLocked &&
    // Ревью Волны 3 (#4): не спускаемся, пока висит НЕсверённое слепое действие — иначе даунгрейд
    // случился бы посреди несведённой verify-сверки (слабый тир добивал бы вслепую).
    !st.honesty.blindMutatePending &&
    st.tier.currentTier === "fable" &&
    !st.tier.familyBoost &&
    recalled !== null &&
    st.tier.cleanRoundsStreak >= 2 &&
    st.tier.escalatedFrom.model !== st.tier.model
  ) {
    st.tier.executorReverted = true;
    st.tier.currentTier = st.tier.escalatedFrom.tier;
    st.tier.model = st.tier.escalatedFrom.model;
    log.info("§Волна3 executor: механика пошла чисто — откат на дешёвый тир (репланинг вернёт сильный)", { tier: st.tier.currentTier });
  }
}

export function tradingEscalation(ctx: LoopCtx, resp: LlmResponse): void {
  const { deps, st } = ctx;
  // §трейдинг: задача коснулась БИРЖЕВОГО инструмента → дальше только МАКС модель (Opus), без тиров
  // (требование: на биржах важна обдуманность). Страховка к роутеру (looksLikeTrading): ловит случаи,
  // где запрос не выглядел биржевым, но привёл к рыночному/торговому инструменту.
  if (resp.toolUses.some((t) => TRADING_TOOLS.has(t.name))) {
    st.tier.strongLocked = true; // §Волна3 (3.2): биржа = осознанная сила, executor вниз НИКОГДА не спускает
    if (st.tier.currentTier !== "fable" && deps.models.fable !== st.tier.model) {
      log.info("§трейдинг: эскалация на макс модель (Opus) — биржевой инструмент в ходе", { from: st.tier.currentTier });
      st.tier.currentTier = "fable";
      st.tier.model = deps.models.fable;
      st.tier.familyBoost = null; // липкая эскалация перекрывает одноразовый family-boost
    }
  }
}

export function escalateOnFailedRound(ctx: LoopCtx, summary: RoundSummary, round: RoundResult): void {
  const { deps, session, text, tier, st, taskId } = ctx;
  const { ESCALATE_AFTER } = ctx.cfg;
  const { allErrored } = summary;
  if (allErrored && round.roundOverlayDenied) {
    // §режим выделения: раунд лёг об вуаль оверлея — это не слабость модели (класс Б4(д) «лечить транспорт
    // Opus'ом»): серию провалов не растим и тир не эскалируем.
    log.info("раунд отклонён вуалью режима выделения — §7-эскалация не считает его провалом", { taskId, round: st.progress.round });
  } else if (allErrored) {
    st.tier.consecErrorRounds += 1;
    if (st.tier.consecErrorRounds >= ESCALATE_AFTER && st.tier.currentTier !== "fable") {
      // аннотация обязательна: вывод типа зацикливается через back-edge петли (currentTier = nextTier)
      // Аудит ядра [1]: идём ВВЕРХ по лестнице тиров до первого с ДРУГОЙ моделью, ПРОПУСКАЯ схлопнутые
      // ступени. Прежний одиночный шаг haiku→sonnet при деф-конфиге (haiku==sonnet=Sonnet) видел ту же
      // модель и уходил в else, форсивший currentTier="fable" БЕЗ смены модели → гард currentTier!=="fable"
      // навсегда ложь → задача застревала на Sonnet и НИКОГДА не доходила до Opus (каскад §7 defeated).
      const TIER_LADDER: readonly Exclude<Tier, "tier0">[] = ["haiku", "sonnet", "fable"];
      const fromIdx = TIER_LADDER.indexOf(st.tier.currentTier);
      let nextTier: Exclude<Tier, "tier0"> | null = null;
      let nextModel = st.tier.model;
      for (let i = fromIdx + 1; i < TIER_LADDER.length; i++) {
        const cand = deps.models[TIER_LADDER[i]!];
        if (cand !== st.tier.model) {
          nextTier = TIER_LADDER[i]!;
          nextModel = cand;
          break;
        }
      }
      if (nextTier) {
        // Реальная эскалация: целевой тир — ДРУГАЯ модель → есть смысл «зайти сильнее».
        // §Волна3 (3.2): помним, ОТКУДА поднялись — executor вернёт дешёвый тир, когда механика
        // пойдёт чисто (≥2 чистых раундов при известной процедуре); новый провал эскалирует снова.
        st.tier.escalatedFrom = { tier: st.tier.currentTier, model: st.tier.model };
        st.tier.cleanRoundsStreak = 0;
        st.tier.currentTier = nextTier;
        st.tier.model = nextModel;
        st.tier.consecErrorRounds = 0;
        st.tier.familyBoost = null; // липкая эскалация перекрывает одноразовый family-boost
        // `model` — модель ТИРА. Если ходы идут резервом (подписка), она не меняется от эскалации
        // вовсе: там модель своя (Opus 5) на любом тире. Пишем оба поля, чтобы лог не создавал
        // впечатление смены модели там, где сменился только эффорт.
        log.info("эскалация тира: модель застряла — захожу сильнее", { to: st.tier.currentTier, model: st.tier.model, фактически: st.tier.modelUsedLast ?? st.tier.model });
        // Filler: дать понять, что не зависли, а пробуем иначе (а не молчать на застревании).
        session.send("transcript", { text: "Секунду, зайду с другой стороны.", final: true });
      } else {
        // Холостая эскалация: выше по лестнице НЕТ другой модели (все схлопнуты в текущую — напр.
        // all-Opus конфиг). «Заходить сильнее» некуда, та же модель не станет умнее. НЕ жжём раунды
        // на мнимый перезаход и НЕ врём «зайду иначе»; помечаем fable, чтобы не пытаться вхолостую.
        st.tier.currentTier = "fable";
        st.tier.familyBoost = null; // маркер «эскалировать некуда» тоже липкий — откат его не снимает
        log.info("эскалация пропущена: выше по лестнице нет другой модели", { model: st.tier.model });
      }
    }
  } else {
    st.tier.consecErrorRounds = 0;
  }
}
