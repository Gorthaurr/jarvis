/**
 * Управление активной задачей по голосу/UI (§20) — вынесено из god-file router-ws.ts (§ревью).
 * Перехват реплик-команд (стоп/отмена/пауза/возобновление/статус), применение к TaskManager и
 * отчёт клиенту, user-takeover (no-op по концепции). `SessionContext` импортируется type-only →
 * рантайм-цикла с router-ws нет (router-ws тянет эти хендлеры как значения, обратно — только тип).
 */
import type { TaskControl, TaskStatus } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { autonomyFreeze, matchAutonomyCommand } from "../autonomy/freeze.js";
import { isOfferDeclined, resumeOfferWindowMs } from "../brain/agent/checkpoint.js";
import { classifyTaskControl } from "../brain/tasks/control.js";
import { stripWakeAndFiller } from "../brain/router/index.js";
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
  // ── KILLSWITCH автономии (волна E) — ПЕРЕД классификатором задач: «полный стоп» не должен
  // падать в обычное «стоп» (stop_tts). Позитивный anchored-матч, нормализация как у роутера
  // (та же грабля, что у resume-гарда: своя копия нормализации разошлась бы).
  const killswitch = matchAutonomyCommand(stripWakeAndFiller(text));
  if (killswitch === "freeze") {
    const cancelled = ctx.agentDeps.tasks.cancelUser(ctx.session.userId);
    const durable = autonomyFreeze().freeze(`команда владельца («${text.trim().slice(0, 60)}»)`);
    // Ack честный по составу: что остановлено, что НЕ остановлено (напоминания — заказаны на время),
    // и КАК вернуть (обещаем ровно ту команду, которую матчер принимает, — обещание без срока годности).
    // «Переживёт перезапуск» звучит ТОЛЬКО когда латч реально лёг на диск (контроль-ревью: freeze мог
    // проглотить провал записи, а супервизор поднимает сервер за 1с — ложная гарантия durable-стопа).
    const stopped = `Полный стоп, сэр: ${cancelled.length > 0 ? `остановил задач: ${cancelled.length}, ` : ""}автономные проверки и проактив заморожены`;
    ackControl(
      ctx,
      durable
        ? `${stopped} — переживёт и перезапуск. Напоминания продолжат срабатывать. Вернуть: «включи автономию».`
        : `${stopped}, но на диск стоп не записался — перезапуск сервера его снимет, повторите команду после рестарта. Напоминания продолжат срабатывать. Вернуть: «включи автономию».`,
      source,
    );
    log.warn("killswitch: владелец остановил автономию", { source, cancelled: cancelled.length, durable });
    return true;
  }
  if (killswitch === "unfreeze") {
    if (!autonomyFreeze().isFrozen()) {
      // Контроль-2: даже при «и так работает» дочищаем остаточный файл-латч — прошлый unfreeze мог
      // не снять его с диска (Windows-лок уже отпустил), и без ретрая рестарт вернул бы стоп,
      // хотя владелец ДВАЖДЫ явно велел его снять.
      const residualClean = autonomyFreeze().unfreeze();
      ackControl(
        ctx,
        residualClean
          ? "Автономия и так работает, сэр."
          : "Автономия и так работает, сэр, но остаточный файл-стоп с диска снять не удалось — после перезапуска она замрёт, скажите тогда «включи автономию».",
        source,
      );
      return true;
    }
    const clean = autonomyFreeze().unfreeze();
    // Контроль-ревью (HIGH): «продолжится само» должно иметь МЕХАНИЗМ — пинаем watch-тик сразу
    // (созревшие проверки/отложенные уведомления не ждут 30с-переопроса замороженного таймера;
    // ambient на setInterval и оживает сам). Fire-and-forget: unfreeze уже случился.
    void ctx.agentDeps.watch?.tickNow();
    // Честность: латч мог не сняться С ДИСКА (Windows-лок) — тогда после рестарта стоп вернётся.
    ackControl(
      ctx,
      clean
        ? "Автономия включена, сэр: наблюдения, проактив и фоновые проверки снова работают."
        : "Автономию включил, сэр, но файл-стоп не удалился с диска — после перезапуска она снова замрёт, скажите тогда ещё раз.",
      source,
    );
    log.info("killswitch: владелец включил автономию", { source, diskClean: clean });
    return true;
  }
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
    if (!ctx.agentDeps.tasks.hasAnyActive(ctx.session.userId)) {
      // Волна C (финальный контроль): активных задач нет, но мы ТОЛЬКО ЧТО предложили продолжить
      // прерванную — «не надо / забудь» в это окно есть ОТКАЗ от предложения. Гасим чекпойнт, иначе
      // обещание живёт весь TTL: сказанное плееру «продолжи» воскрешало бы ЯВНО отклонённую работу.
      // Реплику НЕ съедаем (return false) — она может быть «отмени напоминание» и нужна агенту.
      // ⚠️ Только ГОЛЫЙ отказ (isOfferDeclined): «отмени напоминание про таблетки» — отмена ЧЕГО-ТО
      // ДРУГОГО, и она МОЛЧА уничтожала журнал 12-раундовой работы (контроль-5).
      const cp = isOfferDeclined(text) ? ctx.agentDeps.checkpoints?.peek(ctx.session.userId) : undefined;
      if (cp?.offeredAt !== undefined && Date.now() - cp.offeredAt <= resumeOfferWindowMs()) {
        ctx.agentDeps.checkpoints?.clearIf(ctx.session.userId, cp.taskId);
        log.info("§волна C: владелец отказался продолжать — чекпойнт снят", { taskId: cp.taskId });
      }
      return false; // нечего останавливать — в агент
    }
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
      log.info("task.control: resume", { source, taskId: task.taskId, ok, state: task.state });
      // «Нечего возобновлять» на ИДУЩЕЙ задаче — ложный отказ (контрольное ревью-3 волны C): резюме не
      // требуется, работа не стоит. Тем более теперь «доделай» — слово, которое Джарвис сам предлагает
      // владельцу для продолжения ПРЕРВАННОЙ задачи; услышать на него «нечего» при активной работе
      // сбивает с толку. Честный статус вместо отказа.
      // Ложный отказ был не только на running (финальный контроль волны C): задача в admission-очереди
      // (queued) или на §14-подтверждении (waiting_confirm) — тоже ИДЁТ, «нечего возобновлять» про неё
      // неправда. Тем более «доделай» — слово, которое Джарвис сам предлагает владельцу.
      const inFlight = task.state === "running" || task.state === "queued" || task.state === "waiting_confirm";
      ackControl(
        ctx,
        ok ? "Продолжаю." : inFlight ? "Уже занимаюсь этим, сэр." : "Нечего возобновлять.",
        source,
      );
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
