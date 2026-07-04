/**
 * Управление активной задачей по голосу/UI (§20) — вынесено из god-file router-ws.ts (§ревью).
 * Перехват реплик-команд (стоп/отмена/пауза/возобновление/статус), применение к TaskManager и
 * отчёт клиенту, user-takeover (no-op по концепции). `SessionContext` импортируется type-only →
 * рантайм-цикла с router-ws нет (router-ws тянет эти хендлеры как значения, обратно — только тип).
 */
import type { TaskControl, TaskStatus } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { classifyTaskControl } from "../brain/tasks/control.js";
import { statusReport } from "../brain/tasks/narrate.js";
import type { Task } from "../brain/tasks/task.js";
import { verbalize } from "../brain/verbalize/index.js";
import type { SessionContext } from "./router-ws.js";
import type { Session } from "./session.js";

const log: Logger = createLogger("task-control");

/** Откуда пришла команда управления: голосом (handleControlUtterance) или из UI (task.control). */
export type ControlSource = "voice" | "ui";

/**
 * Ack управления — В ОБА канала (аудит лога 2026-07-03): текстовый transcript И голос через очередь
 * озвучки. Раньше ack был text-only → голосовое «что делаешь?» отвечало молча в чат, а UI-стоп был
 * полностью немым (пользователь снял задачу и не услышал подтверждения — «прекрати поиск у доти»
 * закончилось тишиной). speakQueued не перебивает пользователя — произносит, когда канал свободен.
 */
function ackControl(ctx: SessionContext, text: string): void {
  ctx.session.send("transcript", { text, final: true });
  ctx.voice.speakQueued(verbalize(text));
}

/**
 * Перехватить реплику как команду управления задачей (§20). Возвращает true, если
 * реплика обработана как управление (агент НЕ вызывается).
 *
 *  - «стоп»/«заткнись» (stop_tts) — рубит ТОЛЬКО озвучку (barge-in), задача живёт;
 *  - «отмени»/«пауза»/«продолжи»/«что делаешь» — действуют на активную задачу сессии;
 *    без активной задачи такие реплики НЕ перехватываются (уходят в агент как контент).
 */
export function handleControlUtterance(ctx: SessionContext, text: string): boolean {
  if (!ctx.agentDeps.tasks) return false;
  const decision = classifyTaskControl(text);
  if (decision.kind === "none") return false;

  // «стоп» — оборвать TTS (§20), задачу не трогаем (различие «заткнись» vs «отмени»).
  if (decision.kind === "stop_tts") {
    ctx.voice.onVadEvent("barge_in");
    ctx.voice.clearPendingSpeech(); // пользователь хочет тишины — не озвучивать отложенные фоновые итоги
    ctx.session.send("client.state", { state: "idle" });
    log.info("stop_tts: оборвана озвучка, задача не тронута (§20)", { reason: decision.reason });
    return true;
  }

  // cancel/pause/resume/status осмысленны только при активной задаче.
  const active = ctx.agentDeps.tasks.active(ctx.session.sessionId);
  if (!active) return false;
  if (decision.confidence === "low") {
    // §20: спорная формулировка — действуем по наиболее вероятному kind (Haiku-доуточнение — TODO).
    log.info("низкая уверенность классификации управления — действуем по эвристике", {
      kind: decision.kind,
      reason: decision.reason,
    });
  }
  // «отмени» голосом → «останови ВСЁ, что делаешь»: при параллельных задачах (§20)
  // снимаем все, а не только самую свежую (иначе остальные доедут и озвучат итог).
  // Пауза/возобновление/статус — по самой свежей активной (taskId).
  if (decision.kind === "cancel") {
    handleTaskControl(ctx, "cancel");
    return true;
  }
  handleTaskControl(ctx, decision.kind as TaskControl["action"], active.taskId);
  return true;
}

/** Применить команду управления к задаче и отчитаться клиенту (§20). */
export function handleTaskControl(
  ctx: SessionContext,
  action: TaskControl["action"],
  taskId?: string,
  source: ControlSource = "voice",
): void {
  const tasks = ctx.agentDeps.tasks;
  if (!tasks) return;

  // «отмени» без явного taskId → снять ВСЕ задачи сессии (параллельный режим §20). С
  // явным taskId (кнопка в UI на конкретной задаче) — гранулярная отмена ниже.
  if (action === "cancel" && !taskId) {
    const cancelled = tasks.cancelSession(ctx.session.sessionId);
    ctx.voice.clearPendingSpeech(); // отменил всё → отложенные фоновые итоги тоже не нужны (ack — ПОСЛЕ сброса)
    for (const t of cancelled) emitTaskStatus(ctx.session, t);
    // Аудит лога 2026-07-03: отмена/пауза не оставляли НИ СТРОКИ в файловом логе — разбор «почему
    // задача умерла молча» потребовал дедукции по коду. Логируем каждую команду управления.
    log.info("task.control: cancel-all", { source, cancelled: cancelled.map((t) => t.taskId) });
    ackControl(
      ctx,
      cancelled.length === 0 ? "Нет активной задачи." : cancelled.length > 1 ? "Остановил все, сэр." : "Остановил.",
    );
    ctx.session.send("client.state", { state: "idle" });
    return;
  }

  const task = taskId ? tasks.get(taskId) : tasks.active(ctx.session.sessionId);
  // Защита от кросс-сессионного управления: явный taskId должен принадлежать ЭТОЙ сессии.
  if (task && task.sessionId !== ctx.session.sessionId) {
    log.warn("task.control на задачу чужой сессии — игнор", { taskId, session: ctx.session.sessionId });
    return;
  }
  if (!task) {
    log.info("task.control: без активной задачи", { source, action });
    ackControl(ctx, action === "status" ? "Сейчас ничего не выполняю." : "Нет активной задачи.");
    return;
  }

  switch (action) {
    case "cancel": {
      const ok = tasks.cancel(task.taskId);
      emitTaskStatus(ctx.session, task);
      log.info("task.control: cancel", { source, taskId: task.taskId, title: task.title, ok });
      ackControl(ctx, ok ? "Остановил." : "Уже завершено.");
      ctx.session.send("client.state", { state: "idle" });
      break;
    }
    case "pause": {
      const ok = tasks.pause(task.taskId);
      emitTaskStatus(ctx.session, task);
      log.info("task.control: pause", { source, taskId: task.taskId, ok });
      ackControl(ctx, ok ? "Поставил на паузу." : "Сейчас нельзя поставить на паузу.");
      break;
    }
    case "resume": {
      const ok = tasks.resume(task.taskId);
      emitTaskStatus(ctx.session, task);
      log.info("task.control: resume", { source, taskId: task.taskId, ok });
      ackControl(ctx, ok ? "Продолжаю." : "Нечего возобновлять.");
      break;
    }
    case "status": {
      // Статус: голосом отвечаем на ГОЛОСОВОЙ вопрос («что делаешь?»); из UI панель и так всё видит.
      const text = statusReport(task);
      log.info("task.control: status", { source, taskId: task.taskId });
      if (source === "voice") ackControl(ctx, text);
      else ctx.session.send("transcript", { text, final: true });
      break;
    }
  }
}

/**
 * User-takeover (§6): пользователь взялся за мышь/клавиатуру → агент УСТУПАЕТ управление.
 * active:true ставит активную задачу на паузу (петля перестаёт слать команды), active:false
 * (простой ввода) — возобновляет. Делается тихо (без голосовых реплик) — это автоматика.
 */
export function handleTakeover(_ctx: SessionContext, _active: boolean): void {
  // §20/концепция: НЕ паузим задачу по физическому вводу. Причина: пока ты просто смотришь
  // и шевелишь мышью, авто-пауза флапала (пауза↔возобновление на каждое движение) и
  // «приостанавливала» работу — это против автономного Джарвиса («много агентов, не
  // тормозить, когда я рядом»). Явная остановка — голосом «стоп»/«отмени» (handleTaskControl).
  // Сигнал takeover принимаем, но игнорируем (no-op).
}

/** Стрим состояния/прогресса задачи на клиент (§20, task.status). */
function emitTaskStatus(session: Session, task: Task): void {
  const payload: TaskStatus = {
    taskId: task.taskId,
    state: task.state,
    title: task.title,
    summary: task.goal,
    stepsDone: task.stepsDone,
    stepsTotal: task.stepsTotal,
  };
  session.send("task.status", payload);
}
