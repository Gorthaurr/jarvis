/**
 * Хаб проактивной доставки (§9, Фаза 4) — НЕДОСТАЮЩЕЕ звено: соединяет готовую salience-логику
 * (`shouldInterrupt` + `NudgeQueue`, уже протестированы) с реальной озвучкой (speakQueued). Раньше
 * источники-триггеры эмитили в никуда: `shouldInterrupt` не вызывался нигде в рантайме.
 *
 * УВАЖИТЕЛЬНОСТЬ (урок over-triggering — жалоба Антона «реагирует на всё»): доставляем ТОЛЬКО когда
 * salience разрешает (не в fullscreen/звонке/locked/DND, выше порога важности); занят → откладываем в
 * NudgeQueue и доставляем при освобождении контекста (drain); протухшее (expiresAt) — молча дропаем
 * («выходи в 8:20», сказанное в 11:00, хуже молчания). Источники СОБЫТИЙ (почта/календарь/цены/привычки)
 * — отдельный value-add (нужны интеграции); хаб готов их принять через emit().
 *
 * Чистая логика: канал речи (speak) и часы инъектируются → полный юнит-тест без рантайма.
 */
import type { ClientContext } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { NudgeQueue, shouldInterrupt } from "./salience.js";
import type { Trigger } from "./triggers/index.js";

const log: Logger = createLogger("proactive:hub");

/** Канал озвучки проактивной реплики (= pipeline.speakQueued через registerSpeaker, как у reminders). */
export type ProactiveSpeak = (userId: string, text: string) => void;

export interface ProactiveHubOpts {
  /** Текущий do-not-disturb пользователя (§9) — жёсткий запрет голоса. */
  dnd?: () => boolean;
  /** Источник времени (тесты инъектируют). */
  now?: () => number;
}

export class ProactiveHub {
  private readonly queue = new NudgeQueue();
  constructor(
    private readonly speak: ProactiveSpeak,
    private readonly opts: ProactiveHubOpts = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * Источник эмитит триггер. ctx — последний известный контекст пользователя (из salience-входа).
   * Решение: доставить сейчас / отложить / дропнуть (протух).
   */
  emit(trigger: Trigger, ctx: ClientContext | undefined): void {
    if (trigger.expiresAt <= this.now()) {
      log.debug("проактив: триггер протух — дроп", { id: trigger.id });
      return;
    }
    const d = shouldInterrupt(ctx, trigger, { dnd: this.opts.dnd?.() });
    if (d.interrupt) {
      this.deliver(trigger);
    } else {
      log.debug("проактив: отложен (контекст занят/DND)", { id: trigger.id, reason: d.reason });
      this.queue.enqueue(trigger);
    }
  }

  /**
   * Контекст пользователя изменился/освободился (router зовёт на client.context, как drainPending у
   * reminders) → доставить отложенные УМЕСТНЫЕ; всё ещё нельзя → обратно в очередь; протухшее дропается
   * самим NudgeQueue.flush.
   */
  drain(userId: string, ctx: ClientContext | undefined): void {
    const now = this.now();
    for (const t of this.queue.flush(userId, now)) {
      const d = shouldInterrupt(ctx, t, { dnd: this.opts.dnd?.() });
      if (d.interrupt) this.deliver(t);
      else this.queue.enqueue(t); // ещё занят → ждём следующей разрядки (протух — отсеется flush'ем)
    }
  }

  /** Сколько отложенных nudge ждут юзера (для тестов/диагностики). */
  pending(userId: string): number {
    return this.queue.size(userId);
  }

  private deliver(t: Trigger): void {
    try {
      this.speak(t.userId, t.hint); // hint — черновик-фраза источника; финальная формулировка brain — TODO
      log.info("проактив: доставлено", { id: t.id, importance: t.importance });
    } catch (e) {
      log.warn("проактив: канал речи бросил", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}
