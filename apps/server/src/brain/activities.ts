/**
 * ФОНОВЫЕ АКТИВНОСТИ — «работа, которая продолжается ПОСЛЕ того, как ход агента закончился»
 * (запрос владельца 2026-07-25: «хочу, чтобы фоновые задачи вроде автолистания шортсов отображались
 * ДО КОНЦА, а не пропадали»).
 *
 * Проблема: автолистание Shorts (browser_act feed_auto) живёт в СТРАНИЦЕ и работает десятки минут, а
 * §20-задача агента закрывается через пару секунд («включил») → чип на панели гас, и владелец не видел
 * ни что листание идёт, ни сколько пролистано, ни когда оно кончилось. Наблюдать за собственной работой
 * владелец не обязан — статус должен быть виден.
 *
 * Механика: активность = ЖИВАЯ §20-задача (тот же протокол `task.status`, тот же чип на панели), которую
 * ведёт не петля агента, а этот сервис: раз в `intervalMs` он опрашивает ИСТОЧНИК ПРАВДЫ (для feed_auto —
 * состояние поллера в странице) и обновляет чип реальными числами. Источник сказал «уже не работает» →
 * задача честно закрывается с итогом («пролистал 37, остановился: достигнут лимит роликов»).
 *
 * ЧЕСТНОСТЬ: чип отражает ФАКТ из источника, а не наши намерения. Не смогли опросить (расширение
 * отключено, вкладка закрыта) — активность закрывается с честной причиной, а не «висит зелёной» вечно.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import type { TaskStatus } from "@jarvis/protocol";
import type { TaskManager } from "./tasks/manager.js";

/** Снимок состояния активности от её источника правды. */
export interface ActivityProbeResult {
  /** Работает ли ещё (false → активность завершена). */
  running: boolean;
  /** Сколько единиц работы сделано (для feed_auto — пролистано роликов). */
  done?: number;
  /** Причина остановки, когда running=false («достигнут лимит роликов», «ушли из ленты»). */
  stoppedReason?: string | null;
}

/** Опрос источника правды. Бросок = «опросить не удалось» (активность закроется с честной причиной). */
export type ActivityProbe = () => Promise<ActivityProbeResult>;

interface Activity {
  id: string;
  userId: string;
  taskId: string;
  /** Что показываем в чипе как «что делаю сейчас». */
  label: (done: number) => string;
  probe: ActivityProbe;
  failures: number;
}

/** Канал доставки чипа конкретной живой сессии (регистрируется router-ws, как speaker'ы watch). */
type StatusSender = (payload: TaskStatus) => void;

const MAX_PROBE_FAILURES = 3; // подряд неудачных опросов → закрываем честно, а не держим вечный чип

export class ActivityService {
  private readonly items = new Map<string, Activity>();
  private readonly senders = new Map<string, { userId: string; send: StatusSender }>();
  private timer?: ReturnType<typeof setInterval>;
  private readonly log: Logger;

  constructor(
    private readonly tasks: TaskManager,
    private readonly intervalMs = 15_000,
    log: Logger = createLogger("activities"),
  ) {
    this.log = log;
  }

  /** Канал чипов сессии (router-ws вызывает на handshake; снимается на закрытии соединения). */
  registerStatus(sessionId: string, userId: string, send: StatusSender): void {
    this.senders.set(sessionId, { userId, send });
  }
  unregisterStatus(sessionId: string): void {
    this.senders.delete(sessionId);
  }

  /** Есть ли активность такого рода у пользователя (анти-дубль: второй старт не плодит второй чип). */
  findByKind(userId: string, kind: string): string | undefined {
    for (const [id, a] of this.items) if (a.userId === userId && id.startsWith(`${kind}:`)) return a.id;
    return undefined;
  }

  /**
   * Начать вести активность: создаёт ЖИВУЮ §20-задачу (чип «running» на панели) и берёт её обновление
   * на себя. Повторный старт того же рода для того же пользователя переиспользует существующую.
   */
  start(opts: {
    kind: string;
    userId: string;
    sessionId: string;
    goal: string;
    label: (done: number) => string;
    probe: ActivityProbe;
  }): string {
    const existing = this.findByKind(opts.userId, opts.kind);
    if (existing) {
      const a = this.items.get(existing)!;
      a.probe = opts.probe; // цель могла смениться (другая вкладка) — источник правды берём свежий
      a.failures = 0;
      return existing;
    }
    const task = this.tasks.create({ userId: opts.userId, sessionId: opts.sessionId, goal: opts.goal });
    task.stepLabel = opts.label(0);
    const id = `${opts.kind}:${task.taskId}`;
    this.items.set(id, { id, userId: opts.userId, taskId: task.taskId, label: opts.label, probe: opts.probe, failures: 0 });
    this.emit(opts.userId, task.taskId);
    this.ensureTimer();
    this.log.info("фоновая активность начата — чип виден до конца", { kind: opts.kind, taskId: task.taskId });
    return id;
  }

  /** Завершить активность (явный стоп владельца либо самоостановка источника). */
  finish(id: string, summary: string): void {
    const a = this.items.get(id);
    if (!a) return;
    this.items.delete(id);
    this.tasks.finish(a.taskId, summary);
    this.emit(a.userId, a.taskId);
    this.log.info("фоновая активность завершена", { id, summary });
    if (this.items.size === 0) this.stopTimer();
  }

  /** Завершить активность данного рода у пользователя (для «останови листание»). */
  finishKind(userId: string, kind: string, summary: string): void {
    const id = this.findByKind(userId, kind);
    if (id) this.finish(id, summary);
  }

  /** Один проход опроса (экспортируется для тестов — без таймеров). */
  async tick(): Promise<void> {
    for (const a of [...this.items.values()]) {
      let r: ActivityProbeResult;
      try {
        r = await a.probe();
        a.failures = 0;
      } catch (e) {
        a.failures += 1;
        // Источник недоступен (расширение отключено, вкладка закрыта). Не держим вечно-зелёный чип:
        // после нескольких неудач честно закрываем — «не знаю, что там» хуже, чем признать это.
        if (a.failures >= MAX_PROBE_FAILURES) {
          this.finish(a.id, `прервано: не удалось проверить состояние (${e instanceof Error ? e.message : String(e)})`);
        }
        continue;
      }
      const done = Number.isFinite(r.done) ? Number(r.done) : 0;
      if (!r.running) {
        this.finish(a.id, r.stoppedReason ? `${a.label(done)} — остановлено: ${r.stoppedReason}` : a.label(done));
        continue;
      }
      const task = this.tasks.get(a.taskId);
      if (!task) {
        this.items.delete(a.id); // задачу вымел sweep/рестарт — вести нечего
        continue;
      }
      this.tasks.progress(a.taskId, done);
      task.stepLabel = a.label(done);
      this.emit(a.userId, a.taskId);
    }
  }

  /** Остановить сервис (закрытие gateway). Активности НЕ закрываем: они живут в странице. */
  dispose(): void {
    this.stopTimer();
    this.items.clear();
    this.senders.clear();
  }

  private emit(userId: string, taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const payload: TaskStatus = {
      taskId: task.taskId,
      state: task.state,
      title: task.title,
      summary: task.goal,
      stepsDone: task.stepsDone,
      ...(task.state === "running" && task.stepLabel ? { stepLabel: task.stepLabel } : {}),
    };
    // Шлём во ВСЕ живые сессии этого пользователя (после reconnect sessionId другой — чип не должен
    // потеряться; правило то же, что у проактивной речи напоминаний/наблюдений).
    for (const s of this.senders.values()) if (s.userId === userId) s.send(payload);
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref?.();
  }
  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
