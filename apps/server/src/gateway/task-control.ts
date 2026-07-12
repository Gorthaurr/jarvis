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

/**
 * Откуда пришла команда управления: голосом (handleControlUtterance по голосовому вводу), из текст-канала
 * (dev.text / вкладка «Чат», §22) или из UI (task.control — кнопка на карточке задачи).
 */
export type ControlSource = "voice" | "text" | "ui";

/**
 * Ack управления. M7: озвучиваем (speakQueued) ТОЛЬКО голосовой канал — команды из текст-канала
 * (dev.text/вкладка «Чат») и из UI НЕ должны звучать голосом (нарушало бы text-channel-silent конвенцию
 * §22 mute: печатаешь/в mute — Джарвис отвечает текстом, не говорит). Для не-голосовых каналов ack идёт
 * в transcript + chat-историю (как sendReply), чтобы пользователь ВИДЕЛ подтверждение. speakQueued не
 * перебивает пользователя — произносит, когда канал свободен.
 *
 * (Аудит лога 2026-07-03: голосовое «что делаешь?» раньше отвечало молча в чат, а UI-стоп был полностью
 * немым — «прекрати поиск у доти» закончилось тишиной. Теперь голос звучит, а текст/UI видны в истории.)
 */
function ackControl(ctx: SessionContext, text: string, source: ControlSource): void {
  ctx.session.send("transcript", { text, final: true });
  if (source === "voice") ctx.voice.speakQueued(verbalize(text));
  else ctx.session.send("chat", { role: "assistant", text }); // §22: текст/UI — в чат-историю, без голоса
}

/**
 * Перехватить реплику как команду управления задачей (§20). Возвращает true, если
 * реплика обработана как управление (агент НЕ вызывается).
 *
 *  - «стоп»/«заткнись» (stop_tts) — рубит ТОЛЬКО озвучку (barge-in), задача живёт;
 *  - «отмени» — снимает ВСЕ задачи userId (вкл. скрытые разговорные, Б6) — перехватывается всегда;
 *  - «пауза»/«продолжи»/«что делаешь» — по ВИДИМОЙ активной задаче; без неё в агент как контент.
 *
 * `source` (M7): голосовой ввод → "voice" (ack звучит), текст-канал (dev.text/вкладка «Чат») → "text"
 * (ack только в чат, без голоса — §22). По умолчанию "voice" (обратная совместимость).
 */
export function handleControlUtterance(ctx: SessionContext, text: string, source: ControlSource = "voice"): boolean {
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

  if (decision.confidence === "low") {
    // §20: спорная формулировка — действуем по наиболее вероятному kind (Haiku-доуточнение — TODO).
    log.info("низкая уверенность классификации управления — действуем по эвристике", {
      kind: decision.kind,
      reason: decision.reason,
    });
  }
  // «отмени» голосом → «останови ВСЁ, что делаешь»: cancelUser по USERID (Б4а — переживает reconnect).
  // Ревью волны Б 6-й проход: cancel идёт РАНЬШЕ проверки видимой active — иначе одинокая РАЗГОВОРНАЯ
  // задача (Б6: скрыта из activeForUser) была бы НЕотменяема (research-вопрос до 12 раундов web_*).
  // Интеграционное ревью #6 (РЕГРЕССИЯ): перехватываем cancel ТОЛЬКО если реально есть что отменять
  // (любая активная задача userId, вкл. скрытую разговорную). Иначе «отмени напоминание/подписку»/«забудь
  // что просил» БЕЗ §20-задачи должно уйти в АГЕНТ (cancel_reminder и пр.), а не съесться «Нет задачи».
  if (decision.kind === "cancel") {
    if (!ctx.agentDeps.tasks.hasAnyActive(ctx.session.userId)) return false; // нечего останавливать — в агент
    handleTaskControl(ctx, "cancel", undefined, source);
    return true;
  }
  // pause/resume/status осмысленны только при ВИДИМОЙ активной задаче (по самой свежей taskId).
  const active = ctx.agentDeps.tasks.activeForUser(ctx.session.userId)[0];
  if (!active) return false;
  handleTaskControl(ctx, decision.kind as TaskControl["action"], active.taskId, source);
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

  // «отмени» без явного taskId → снять ВСЕ задачи ПОЛЬЗОВАТЕЛЯ (Б4а: по userId — переживает
  // reconnect со сменой sessionId). С явным taskId (кнопка в UI) — гранулярная отмена ниже.
  if (action === "cancel" && !taskId) {
    const cancelled = tasks.cancelUser(ctx.session.userId);
    ctx.voice.clearPendingSpeech(); // отменил всё → отложенные фоновые итоги тоже не нужны (ack — ПОСЛЕ сброса)
    for (const t of cancelled) emitTaskStatus(ctx.session, t);
    // Аудит лога 2026-07-03: отмена/пауза не оставляли НИ СТРОКИ в файловом логе — разбор «почему
    // задача умерла молча» потребовал дедукции по коду. Логируем каждую команду управления.
    log.info("task.control: cancel-all", { source, cancelled: cancelled.map((t) => t.taskId) });
    ackControl(
      ctx,
      cancelled.length === 0 ? "Нет активной задачи." : cancelled.length > 1 ? "Остановил все, сэр." : "Остановил.",
      source,
    );
    ctx.session.send("client.state", { state: "idle" });
    return;
  }

  // HIGH-4 (ревью 2026-07-10): адресация и гвард — по ВЛАДЕЛЬЦУ (userId), не по sessionId. После
  // reconnect sessionId новый, а задача жива в старой сессии: прежний гвард молча `return` — «пауза»/
  // «что делаешь» умирали В ПОЛНОЙ ТИШИНЕ (живой пробник: перехвачено=true, озвучено=0). Пользователь
  // один — его команды применимы к его задачам из любой сессии; отказ ВСЕГДА озвучивается, не молчит.
  const task = taskId ? tasks.get(taskId) : tasks.activeForUser(ctx.session.userId)[0];
  if (task && task.userId !== ctx.session.userId) {
    log.warn("task.control на задачу ЧУЖОГО пользователя — отказ", { taskId, userId: ctx.session.userId });
    ackControl(ctx, "Эта задача не ваша, сэр.", source);
    return;
  }
  if (!task) {
    log.info("task.control: без активной задачи", { source, action });
    ackControl(ctx, action === "status" ? "Сейчас ничего не выполняю." : "Нет активной задачи.", source);
    return;
  }

  switch (action) {
    case "cancel": {
      const ok = tasks.cancel(task.taskId);
      emitTaskStatus(ctx.session, task);
      log.info("task.control: cancel", { source, taskId: task.taskId, title: task.title, ok });
      ackControl(ctx, ok ? "Остановил." : "Уже завершено.", source);
      ctx.session.send("client.state", { state: "idle" });
      break;
    }
    case "pause": {
      const ok = tasks.pause(task.taskId);
      emitTaskStatus(ctx.session, task);
      log.info("task.control: pause", { source, taskId: task.taskId, ok });
      ackControl(ctx, ok ? "Поставил на паузу." : "Сейчас нельзя поставить на паузу.", source);
      break;
    }
    case "resume": {
      const ok = tasks.resume(task.taskId);
      emitTaskStatus(ctx.session, task);
      log.info("task.control: resume", { source, taskId: task.taskId, ok });
      ackControl(ctx, ok ? "Продолжаю." : "Нечего возобновлять.", source);
      break;
    }
    case "status": {
      // Статус: голосом отвечаем на ГОЛОСОВОЙ вопрос («что делаешь?»); из текст-канала/UI — только текстом
      // (панель и так всё видит; §22 — не озвучиваем печатающему/в mute). ackControl сам гейтит голос по source.
      const text = statusReport(task);
      log.info("task.control: status", { source, taskId: task.taskId });
      if (source === "voice") ackControl(ctx, text, source);
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
