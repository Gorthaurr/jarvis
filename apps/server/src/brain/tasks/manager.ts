/**
 * Реестр долгих задач (§20) — in-process per-process центр учёта M8.
 *
 * Менеджер хранит {@link Task} по taskId и обслуживает жизненный цикл (§20):
 * create → running → (pause/resume) → done/failed/cancelled. Команды голоса/UI
 * («стоп»/«отмени»/«пауза»/«продолжи»/«что делаешь») приходят без taskId — для них
 * есть {@link TaskManager.active}, возвращающий самую свежую живую задачу сессии.
 *
 * Ключевая инвариантность §20: cancel НЕ заменяет объект cancel-флага, а мутирует
 * `cancelled=true` ровно у того экземпляра {@link CancelFlag}, что вернул create(),
 * чтобы петля агента, держащая ссылку на `task.cancel`, увидела отмену перед шагом.
 *
 * Часы инъецируются (now: () => number, unix ms) — чтобы тесты прогресса/sweep/
 * сортировки были детерминированы и не зависели от системного времени.
 */
import { newId } from "@jarvis/protocol";
import type { PersistedTask, Task, TaskState } from "./task.js";
import { deriveTaskTitle, isActiveState, isSubstantiveTask, isTerminalState } from "./task.js";

/** Параметры создания задачи (§20): кто, в какой сессии, что просили. */
export interface CreateTaskOpts {
  userId: string;
  sessionId: string;
  /** Человеческая формулировка цели («сделай таблицу расходов»). */
  goal: string;
  /** Всего шагов — для скилла известно; undefined для open-ended LLM-петли. */
  stepsTotal?: number;
}

/** TTL по умолчанию для sweep: терминальные задачи живут 10 минут (§20-отчётность). */
const DEFAULT_SWEEP_TTL_MS = 10 * 60 * 1000;

/**
 * In-process реестр задач (§20). Один на процесс; per-user/per-session — фильтрами
 * по полям задачи. Без внешних зависимостей и без таймеров: течение времени и
 * чистка управляются явными вызовами progress/sweep с инъецированным now.
 */
export class TaskManager {
  /** taskId → задача. Map сохраняет порядок вставки (полезно для list/active). */
  private readonly tasks = new Map<string, Task>();

  /**
   * Колбэк на любое ИЗМЕНЕНИЕ реестра (для персиста на диск §5) — дебаунсит вызывающий
   * (см. task-store). Зеркалит WorkingMemory.onChange. Не дёргается на чтениях (get/list/active).
   */
  private onChange?: () => void;

  /**
   * @param now источник unix-ms времени. По умолчанию системные часы; тесты
   *   ВСЕГДА передают свою функцию для детерминизма.
   */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Назначить колбэк персиста (вызывается после каждой мутации жизненного цикла). */
  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  /**
   * Создать задачу в состоянии "running" (§20): прогресс 0, свежий cancel-флаг
   * {cancelled:false}, taskId через newId(), startedAt по инъецированным часам.
   */
  create(opts: CreateTaskOpts): Task {
    const task: Task = {
      taskId: newId(),
      userId: opts.userId,
      sessionId: opts.sessionId,
      goal: opts.goal,
      title: deriveTaskTitle(opts.goal),
      state: "running",
      stepsDone: 0,
      stepsTotal: opts.stepsTotal,
      startedAt: this.now(),
      cancel: { cancelled: false },
      steer: { pending: [] },
    };
    this.tasks.set(task.taskId, task);
    this.onChange?.();
    return task;
  }

  /**
   * Правка на ходу (§20): добавить указание пользователя в очередь активной задачи. Петля сольёт его
   * перед очередным шагом и впрыснет в диалог LLM (см. agent-loop). Возвращает true, если задача жива
   * (можно рулить); false — терминальная/не найдена (тогда вызывающий трактует реплику как новую).
   */
  steer(taskId: string, text: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || !isActiveState(task.state)) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    task.steer.pending.push(trimmed);
    return true;
  }

  /** Задача по id (или undefined, если нет/была вычищена sweep). */
  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Самая свежая НЕтерминальная задача сессии (§20) — адресат команд без taskId
   * («стоп», «продолжи», «что делаешь»). По startedAt desc среди активных.
   */
  active(sessionId: string): Task | undefined {
    let best: Task | undefined;
    for (const task of this.tasks.values()) {
      if (task.sessionId !== sessionId) continue;
      if (!isActiveState(task.state)) continue;
      // `>=`: при равном startedAt (быстрый fan-out / замороженные часы в тестах) побеждает
      // ПОЗЖЕ вставленная (Map хранит порядок вставки) — команда без taskId уходит свежайшей задаче.
      if (!best || task.startedAt >= best.startedAt) best = task;
    }
    return best;
  }

  /** Задачи пользователя, свежие первыми (по startedAt desc) — для списка/истории. */
  list(userId: string): Task[] {
    return [...this.tasks.values()]
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Обновить прогресс активной задачи (§20). No-op (undefined) для терминальной:
   * после done/failed/cancelled прогресс не меняется. stepsTotal обновляется,
   * только если передан явно.
   */
  progress(taskId: string, stepsDone: number, stepsTotal?: number): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task || isTerminalState(task.state)) return undefined;
    if (stepsTotal !== undefined) task.stepsTotal = Number.isFinite(stepsTotal) ? Math.max(0, stepsTotal) : task.stepsTotal;
    // Кламп прогресса: не уходим в минус и не за известный total (иначе чип-прогресс прыгает >100%/назад).
    const safe = Number.isFinite(stepsDone) ? Math.max(0, stepsDone) : task.stepsDone;
    task.stepsDone = task.stepsTotal !== undefined ? Math.min(safe, task.stepsTotal) : safe;
    this.onChange?.();
    return task;
  }

  /**
   * §20: «отмени» — прервать задачу. Мутирует cancel.cancelled=true (ТОТ ЖЕ объект,
   * что у петли агента), выставляет state "cancelled" и finishedAt. Идемпотентно:
   * false, если задачи нет или она уже терминальна.
   */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || isTerminalState(task.state)) return false;
    task.cancel.cancelled = true;
    task.state = "cancelled";
    task.finishedAt = this.now();
    this.onChange?.();
    return true;
  }

  /**
   * §20: снять ВСЕ незавершённые задачи сессии. Нужно для параллельного режима:
   * голосовое «отмени» означает «останови всё, что делаешь», а активных задач может
   * быть несколько (Semaphore>1). Мутирует cancel.cancelled у каждой (петли увидят) и
   * переводит в "cancelled". Возвращает снятые задачи (для стрима task.status в UI).
   */
  cancelSession(sessionId: string): Task[] {
    const cancelled: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.sessionId !== sessionId || isTerminalState(task.state)) continue;
      task.cancel.cancelled = true;
      task.state = "cancelled";
      task.finishedAt = this.now();
      cancelled.push(task);
    }
    if (cancelled.length > 0) this.onChange?.();
    return cancelled;
  }

  /** §20: «пауза» — running/queued → paused. false для прочих состояний. */
  pause(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.state !== "running" && task.state !== "queued") return false;
    task.state = "paused";
    this.onChange?.();
    return true;
  }

  /** §20: «продолжи» — paused → running. false, если задача не на паузе. */
  resume(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.state !== "paused") return false;
    task.state = "running";
    this.onChange?.();
    return true;
  }

  /**
   * Успешное завершение (§20): state "done", finishedAt, resultSummary для отчёта.
   * No-op (undefined), если задачи нет или она уже терминальна.
   */
  finish(taskId: string, summary?: string): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task || isTerminalState(task.state)) return undefined;
    task.state = "done";
    task.finishedAt = this.now();
    if (summary !== undefined) task.resultSummary = summary;
    this.onChange?.();
    return task;
  }

  /**
   * Провал (§20): state "failed", finishedAt, lastError (причина для errorReport).
   * No-op (undefined), если задачи нет или она уже терминальна.
   */
  fail(taskId: string, error: string): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task || isTerminalState(task.state)) return undefined;
    task.state = "failed";
    task.finishedAt = this.now();
    task.lastError = error;
    this.onChange?.();
    return task;
  }

  /**
   * Чистка завершённых задач (§20): удалить терминальные с finishedAt старше ttlMs
   * относительно переданного now. Активные задачи не трогаем. Возвращает число
   * удалённых.
   */
  sweep(now: number, ttlMs: number = DEFAULT_SWEEP_TTL_MS): number {
    let removed = 0;
    for (const [taskId, task] of this.tasks) {
      if (!isTerminalState(task.state)) continue;
      const finishedAt = task.finishedAt ?? task.startedAt;
      if (now - finishedAt > ttlMs) {
        this.tasks.delete(taskId);
        removed += 1;
      }
    }
    if (removed > 0) this.onChange?.();
    return removed;
  }

  /**
   * §20: терминальные СОДЕРЖАТЕЛЬНЫЕ задачи пользователя для «осознания» — отвечать на «сделал?»/«что
   * делал?» из ДОЛГОВЕЧНОГО реестра, а не из хрупкого окна реплик (которое вытесняется и стирается
   * рестартом). Пустая болтовня (stepsDone=0) ОТСЕКАЕТСЯ (isSubstantiveTask) — иначе история засоряется
   * «✓ Привет» и раздувается хвост промпта. Свежие первыми (finishedAt desc), не старше maxAgeMs, не
   * больше limit. Чистая выборка (без мутаций).
   */
  recentTerminal(userId: string, opts: { limit?: number; maxAgeMs?: number; now?: number } = {}): Task[] {
    const { limit = 5, maxAgeMs = Number.POSITIVE_INFINITY, now = this.now() } = opts;
    return [...this.tasks.values()]
      .filter((t) => t.userId === userId && isTerminalState(t.state) && isSubstantiveTask(t))
      .filter((t) => now - (t.finishedAt ?? t.startedAt) <= maxAgeMs)
      .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))
      .slice(0, Math.max(0, limit));
  }

  /**
   * §20 «осознание»: АКТИВНЫЕ задачи пользователя (running/queued/paused) — чтобы на «что делаешь?»/
   * «сделал?» во время фоновой работы Джарвис честно сказал «ещё считаю», а не «ничего не делаю»
   * (баг: фоновая задача в полёте не попадала в контекст). excludeId — таск ТЕКУЩЕГО хода (не он сам).
   * Свежие первыми. Чистая выборка.
   */
  activeForUser(userId: string, excludeId?: string): Task[] {
    return [...this.tasks.values()]
      .filter((t) => t.userId === userId && isActiveState(t.state) && t.taskId !== excludeId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Сериализовать реестр для персиста на диск (§5): снимок задач БЕЗ рантайм-флага `cancel`
   * (живой объект отмены имеет смысл только в текущем процессе). Зеркалит WorkingMemory.toJSON.
   */
  toJSON(): { tasks: PersistedTask[] } {
    const tasks: PersistedTask[] = [];
    for (const t of this.tasks.values()) {
      const { cancel, ...rest } = t;
      tasks.push(rest);
    }
    return { tasks };
  }

  /**
   * Восстановить реестр из персиста (§5). КЛЮЧЕВАЯ ЧЕСТНОСТЬ: задача, бывшая НЕ-терминальной на
   * момент снимка (running/queued/paused/waiting_confirm), пережить рестарт процесса НЕ может —
   * петля агента, что её исполняла, умерла. Поэтому такие задачи помечаем "failed"
   * («прервано перезапуском»), а НЕ воскрешаем как живые (иначе Джарвис соврёт «всё ещё делаю»).
   * Терминальные (done/failed/cancelled) переносятся как есть — это и есть память «что я сделал».
   * НЕ дёргает onChange (как WorkingMemory.restore).
   */
  restore(data: { tasks?: PersistedTask[] } | null | undefined, now: number = this.now()): void {
    if (!data || !Array.isArray(data.tasks)) return;
    for (const p of data.tasks) {
      if (!p || typeof p.taskId !== "string") continue;
      const interrupted = !isTerminalState(p.state);
      // Защита от битого/правленного снимка: нечисловые времена → конечные значения, иначе NaN
      // отравил бы сортировку recentTerminal и дал бы «NaN дн назад» в промпте (честность «сделал?»).
      const startedAt = Number.isFinite(p.startedAt) ? p.startedAt : now;
      const finite = Number.isFinite(p.finishedAt) ? (p.finishedAt as number) : undefined;
      const task: Task = {
        ...p,
        startedAt,
        // Прерванной задаче сохраняем её РЕАЛЬНОЕ последнее время (finishedAt→startedAt), а НЕ «now»:
        // иначе все восстановленные провалы слиплись бы на момент рестарта и вытеснили реальные успехи
        // из топ-N recentTerminal (а время «провалился» было бы датировано позже, чем он жил).
        state: interrupted ? "failed" : p.state,
        finishedAt: interrupted ? (finite ?? startedAt) : finite,
        lastError: interrupted ? (p.lastError ?? "прервано перезапуском сервера") : p.lastError,
        cancel: { cancelled: isTerminalState(p.state) ? p.state === "cancelled" : true },
        steer: { pending: [] }, // правки на ходу — рантайм-канал, на восстановлении пустой
      };
      this.tasks.set(task.taskId, task);
    }
  }
}
