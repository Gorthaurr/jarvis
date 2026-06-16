/**
 * Диспетчер входящих WS-сообщений (§5).
 *
 * Принимает разобранный Envelope и маршрутизирует по MessageType:
 *   dev.text            → brain.handleUserText → speak.chunk-ответ (M0: transcript+ui.display)
 *   action.result       → резолв in-flight команды в Session
 *   pong                → heartbeat.notePong
 *   client.context      → proactive (salience-вход §9)
 *   user.confirm.result → резолв ожидающего confirm в Session
 *   client.state        → лог/диагностика
 *   audio.* / vad       → точка под голосовой пайплайн (M1) — пока лог
 *
 * Router держит per-session состояние (рабочая память) в SessionContext.
 */
import {
  type ActionResult,
  type AudioFrame,
  type ClientContext,
  type ClientEnv,
  type ClientStateMsg,
  type ConfirmResult,
  type DemoSave,
  type DevText,
  type Envelope,
  type MessageType,
  type SkillSaved,
  type Takeover,
  type TaskControl,
  type TaskStatus,
  type VadEvent,
} from "@jarvis/protocol";
import { AsyncMutex, type Logger, Semaphore, type Tier, createLogger } from "@jarvis/shared";
import { type AgentDeps, type AgentReply, handleUserText } from "../brain/agent/index.js";
import { SessionWarmth } from "../brain/agent/warmth.js";
import type { ButlerAcks } from "../brain/persona/acks.js";
import { getMode } from "../brain/persona/modes.js";
import type { DynamicToolStore } from "../brain/tools/dynamic.js";
import { getProfile } from "../brain/profile.js";
import type { SpendGuard } from "../billing/index.js";
import type { ILlmProvider } from "../integrations/llm.js";
import type { EpisodicMemory } from "../memory/episodic.js";
import type { IWebProvider } from "../integrations/web.js";
import type { ISttProvider, ITtsProvider, TtsChunk } from "../integrations/voice-providers.js";
import { WorkingMemory } from "../memory/working.js";
import { noteClientContext } from "../proactive/salience.js";
import { TaskManager } from "../brain/tasks/manager.js";
import { classifyTaskControl } from "../brain/tasks/control.js";
import { statusReport } from "../brain/tasks/narrate.js";
import { saveDemonstratedSkill } from "../brain/skills/record.js";
import { type SkillProvider, hasGuardSteps, isLearnedMd, listSkills } from "../memory/skills.js";
import type { Task } from "../brain/tasks/task.js";
import { type VoicePipeline, createVoicePipeline } from "../voice/index.js";
import type { HeartbeatHandle } from "./heartbeat.js";
import type { ExtensionBridge } from "./extension-bridge.js";
import type { Session } from "./session.js";

const log: Logger = createLogger("router-ws");

/** Голосовые провайдеры, общие на gateway (создаются один раз из конфига). */
export interface VoiceProviders {
  stt: ISttProvider;
  tts: ITtsProvider;
  voiceId?: string;
}

/** Мозговые провайдеры, общие на gateway (§7, §8, §12, §14). */
export interface BrainProviders {
  llm: ILlmProvider;
  episodic: EpisodicMemory;
  web: IWebProvider;
  spend: SpendGuard;
  models: Record<Exclude<Tier, "tier0">, string>;
  /** Реестр долгих задач (§20) — общий на gateway: голос/UI управляют активной задачей. */
  tasks: TaskManager;
  /** Тёплость сессий для §15-кеширования — общая на gateway. */
  warmth: SessionWarmth;
  /** Реестр самописных инструментов (§8+ саморасширение) — общий на gateway. */
  dynamicTools: DynamicToolStore;
  /** Провайдер выученных показом навыков (§8) — общий на gateway. */
  skills: SkillProvider;
  /** Пул дворецких подтверждений голосом персоны (§11) — общий на gateway (прегенерация одна). */
  acks: ButlerAcks;
  /** Мост к браузерному расширению (§6): невидимая отправка в Telegram и т.п. */
  extBridge: ExtensionBridge;
}

/** Потолок параллельных фоновых agent-loop'ов на сессию (§20): «много агентов», но не
 *  бесконечно (LLM/CPU). GUI-задачи всё равно сериализует аренда ввода; research-задачи
 *  бегут реально параллельно. */
const MAX_PARALLEL_TASKS = 5;

/** Контекст одного соединения, который держит router между сообщениями. */
export interface SessionContext {
  session: Session;
  memory: WorkingMemory;
  heartbeat: HeartbeatHandle;
  /** Голосовой пайплайн сессии (§10). */
  voice: VoicePipeline;
  /** Зависимости agent-loop (§7, §8). */
  agentDeps: AgentDeps;
  /** Последний полученный ClientContext — вход для proactive (§9). */
  lastContext?: ClientContext;
  /**
   * Закрытие сессии (§20): помечаем закрытой (фоновый итог не озвучиваем в мёртвую
   * сессию) и снимаем её незавершённые задачи. Вызывается gateway по ws-close.
   */
  disposeAgent(): void;
}

/** Создать контекст для свежей/возобновлённой сессии. */
export function makeSessionContext(
  session: Session,
  heartbeat: HeartbeatHandle,
  providers: VoiceProviders,
  brain: BrainProviders,
): SessionContext {
  const memory = new WorkingMemory();
  // Per-session состояние async-контура (§20): живёт с сессией, GC'ится с контекстом —
  // никаких процесс-глобальных Map по sessionId (прежний bgChains тёк на каждой сессии).
  const inputArbiter = new AsyncMutex(); // аренда мыши/клавы/фокуса — сериализует GUI-команды
  const concurrency = new Semaphore(MAX_PARALLEL_TASKS); // потолок параллельных agent-loop'ов
  const bgTasks = new Set<Promise<void>>(); // живые фоновые задачи (для чистки на закрытии)
  let closed = false;
  const agentDeps: AgentDeps = {
    memory,
    llm: brain.llm,
    episodic: brain.episodic,
    web: brain.web,
    models: brain.models,
    spend: brain.spend,
    userId: session.userId,
    // Персистентный профиль (§8/§11): имя/факты из data/profile.json → в персону,
    // чтобы Джарвис ПОМНИЛ пользователя и не спрашивал имя каждый раз.
    userContext: { displayName: getProfile().displayName, facts: getProfile().facts },
    tasks: brain.tasks, // общий реестр: «отмени» из UI мутирует флаг задачи в петле (§20)
    warmth: brain.warmth, // общая тёплость сессий (§15)
    dynamicTools: brain.dynamicTools, // §8+ самописные инструменты в наборе модели
    skills: brain.skills, // §8 выученные показом навыки (skill_list/skill_execute)
    inputArbiter, // §20: GUI-команды (вкл. tier0) сериализуются, прочее — параллельно
    concurrency, // §20: ограничитель параллельных фоновых задач
    bgTasks, // §20: реестр живых фоновых задач
    acks: brain.acks, // §11: дворецкие подтверждения голосом персоны (прегенерация)
    ackRotation: 0, // §11: ротация ack per-session
    isClosed: () => closed, // §20: не озвучивать итог в закрытую сессию
    // §6: невидимая отправка в Telegram через браузерное расширение (фоновая вкладка).
    telegramSend: (to, text) => brain.extBridge.telegramSend(to, text),
  };
  const voice = createVoicePipeline({
    stt: providers.stt,
    tts: providers.tts,
    ttsVoiceId: providers.voiceId,
    // §11: голос активного режима-маски — берётся на каждый синтез из профиля, поэтому
    // «будь дерзким» меняет подачу мгновенно (без пересоздания пайплайна).
    getVoiceOpts: () => {
      const m = getMode(getProfile().mode).voice;
      return m ? { voiceId: m.voiceId, stability: m.stability, style: m.style, speed: m.speed } : undefined;
    },
    // §3 wake word: реагировать только на обращение «Джарвис» (вне окна разговора).
    requireWakeWord: true,
    // brain на финальном тексте реплики (§21: {voice, display?}).
    onUserTurn: (text) => handleUserText(session, text, agentDeps),
    // speak.chunk: аудио по WS — DEV-путь (в проде WebRTC, §5). Кодируем в base64.
    sendSpeakChunk: (c: TtsChunk) =>
      session.send("speak.chunk", { audio: bufToBase64(c.audio), seq: c.seq, last: c.last }),
    sendClientState: (s) => session.send("client.state", { state: s }),
    sendTranscript: (t) => session.send("transcript", t),
    sendDisplay: (d) => session.send("ui.display", d),
  });
  // §20 async: фоновые задачи не блокируют разговор — их ИТОГ озвучивается через
  // очередь пайплайна (когда канал свободен), плюс карточка в renderer.
  agentDeps.speakResult = (reply) => {
    voice.speakQueued(reply.voice);
    if (reply.display) session.send("ui.display", reply.display);
  };
  const disposeAgent = (): void => {
    closed = true;
    // Снимаем ВСЕ незавершённые задачи сессии одним проходом: петли увидят cancel-флаг,
    // выйдут ≤1 шага и освободят аренду ввода; задачи сами удалятся из bgTasks по завершении.
    // Озвучку фонового итога глушит isClosed() — в мёртвую сессию не говорим (§20).
    brain.tasks.cancelSession(session.sessionId);
  };
  return { session, memory, heartbeat, voice, agentDeps, disposeAgent };
}

/**
 * Обработать одно входящее сообщение. Возвращает Promise — вызывающий
 * (gateway) может не ждать, но мы await'им для упорядоченной обработки текста.
 */
export async function dispatch(ctx: SessionContext, env: Envelope): Promise<void> {
  const type = env.type as MessageType;
  switch (type) {
    case "dev.text":
      await onDevText(ctx, env.payload as DevText);
      break;
    case "action.result":
      ctx.session.resolveAction(env.payload as ActionResult);
      break;
    case "user.confirm.result":
      ctx.session.resolveConfirm(env.payload as ConfirmResult);
      break;
    case "pong":
      ctx.heartbeat.notePong();
      break;
    case "ping":
      ctx.session.send("pong", {});
      break;
    case "client.context": {
      const c = env.payload as ClientContext;
      ctx.lastContext = c;
      noteClientContext(ctx.session.sessionId, c); // вход salience (§9)
      break;
    }
    case "client.state":
      log.debug("client.state", (env.payload as ClientStateMsg).state);
      break;
    case "task.control": {
      // Управление задачей из UI (кнопка «стоп»/«пауза»/«продолжить», §20).
      const c = env.payload as TaskControl;
      handleTaskControl(ctx, c.action, c.taskId);
      break;
    }
    case "client.takeover": {
      // Пользователь взялся за ввод (§6) → агент уступает: пауза/возобновление задачи.
      handleTakeover(ctx, (env.payload as Takeover).active);
      break;
    }
    case "client.env": {
      // §9: авто-профиль окружения (браузер/приложения) → в системный промпт сессии,
      // чтобы агент адаптировался под конкретного пользователя (не хардкод).
      const summary = (env.payload as ClientEnv).summary;
      ctx.agentDeps.userContext = { ...ctx.agentDeps.userContext, environment: summary };
      log.info("client.env: профиль окружения получен", { len: summary?.length ?? 0 });
      break;
    }
    case "audio.frame": {
      const f = env.payload as AudioFrame;
      ctx.voice.onAudioFrame(toArrayBuffer(f.pcm));
      break;
    }
    case "audio.vad":
      ctx.voice.onVadEvent((env.payload as VadEvent).state);
      break;
    case "screen.capture.result":
      // Результат screen.capture коррелируется как ActionResult в проде;
      // M0 — лог. TODO(M2): связать со screen.capture command.
      log.debug("screen.capture.result получен");
      break;
    case "demo.event":
      // Поток событий идёт в main для счётчика UI; авторитетный батч приходит в demo.save.
      log.debug("demo.event (стрим записи демонстрации)");
      break;
    case "demo.save":
      await onDemoSave(ctx, env.payload as DemoSave);
      break;
    default:
      log.warn("необработанный тип входящего сообщения", { type });
  }
}

/** dev.text → агент → ответ клиенту (transcript + speak + опц. карточка). */
async function onDevText(ctx: SessionContext, payload: DevText): Promise<void> {
  const text = payload?.text ?? "";
  if (!text.trim()) return;

  // Голосовое/текстовое управление задачей (§20): «отмени»/«пауза»/«продолжи»/«что
  // делаешь» перехватываем ДО агента, если есть активная задача. «стоп» (stop_tts)
  // рубит озвучку. Иначе — обычная реплика идёт в агент.
  if (handleControlUtterance(ctx, text)) return;

  ctx.session.send("client.state", { state: "thinking" });
  let reply: AgentReply;
  try {
    reply = await handleUserText(ctx.session, text, ctx.agentDeps);
  } catch (e) {
    log.error("ошибка agent.handleUserText", e instanceof Error ? e.message : String(e));
    ctx.session.send("client.state", { state: "idle" });
    ctx.session.send("error", { code: "internal", message: "внутренняя ошибка обработки" });
    return;
  }

  sendReply(ctx, reply);
}

/**
 * demo.save → построить навык из демонстрации, сохранить и подтвердить (§8).
 * Голосом докладываем итог; карточкой показываем шаги; skill.saved кладёт навык
 * в клиентский реестр (повтор без сервера). Guard-шаги → предупреждаем про ревью (§14).
 */
async function onDemoSave(ctx: SessionContext, payload: DemoSave): Promise<void> {
  const name = (payload?.name ?? "").trim();
  const events = payload?.events ?? [];
  if (!name || events.length === 0) {
    ctx.voice.speak("Не удалось записать навык — я не увидел действий.");
    return;
  }

  let saved;
  try {
    saved = await saveDemonstratedSkill(ctx.session.userId, {
      name,
      events,
      ...(payload.commentary ? { commentary: payload.commentary } : {}),
    });
  } catch (e) {
    log.error("ошибка saveDemonstratedSkill", e instanceof Error ? e.message : String(e));
    ctx.voice.speak("Не получилось сохранить навык. Попробуйте ещё раз.");
    return;
  }

  if (!saved) {
    ctx.voice.speak(`Навык «${name}» не записан — я не разобрал значимых действий.`);
    return;
  }

  const msg: SkillSaved = {
    id: saved.id,
    name: saved.name,
    version: saved.version,
    steps: saved.steps,
    needsReview: saved.needsReview,
  };
  ctx.session.send("skill.saved", msg);
  ctx.session.send("ui.display", {
    title: `Навык записан: ${saved.name}`,
    markdown:
      `Запомнил ${saved.stepCount} шаг(ов).` +
      (saved.needsReview ? "\n\n⚠️ Есть необратимые шаги — перед первым повтором покажу на подтверждение." : ""),
  });
  ctx.voice.speak(
    saved.needsReview
      ? `Готово, сэр. Навык «${saved.name}» записан. В нём есть необратимые шаги — перед первым повтором я уточню.`
      : `Готово, сэр. Навык «${saved.name}» записан, ${saved.stepCount} шагов. Скажите повторить — и я выполню.`,
  );
}

/** Прислать клиенту ранее записанные навыки на старте сессии (§8). */
export function pushSavedSkills(ctx: SessionContext): void {
  void listSkills(ctx.session.userId)
    .then((skills) => {
      // ВАЖНО: выученные показом РЕПЛЕЙ-навыки — да; выученные-процедуры (§8 HERMES) — НЕТ:
      // их «шаги» — это derived-парс прозы, их нельзя реплеить кнопкой (только следовать в
      // recall'е). Иначе процедура с строкой вида `code.run …`/`confirm …` исполнилась бы по
      // клику. needsReview берём из guard-шагов (§14), а не хардкодим false.
      const replayable = skills.filter((s) => !isLearnedMd(s.contentMd));
      for (const s of replayable) {
        const msg: SkillSaved = {
          id: s.id,
          name: String((s.steps.length && s.contentMd.match(/^name:\s*(.+)$/m)?.[1]) || s.id),
          version: s.version,
          steps: s.steps,
          needsReview: hasGuardSteps(s.steps),
        };
        ctx.session.send("skill.saved", msg);
      }
      if (replayable.length) log.info(`проброшено навыков клиенту: ${replayable.length}`);
    })
    .catch((e) => log.warn(`listSkills недоступен: ${e instanceof Error ? e.message : String(e)}`));
}

/**
 * Отправить ответ агента клиенту.
 * M0: голос как Transcript (текст) — реальный TTS-стрим speak.chunk появится в M1.
 * Карточка (если есть) — отдельным каналом ui.display (§21).
 */
function sendReply(ctx: SessionContext, reply: AgentReply): void {
  ctx.session.send("transcript", { text: reply.voice, final: true });
  if (reply.display) ctx.session.send("ui.display", reply.display);
  ctx.session.send("client.state", { state: "idle" });
  // Примечание: голосовой ответ (speak.chunk из TTS) идёт через VoicePipeline
  // на голосовом пути (audio.frame→STT→agent→TTS). Текстовый dev.text-путь
  // отдаёт только transcript/ui.display.
}

// ── управление задачами (§20) ──────────────────────────────────

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
export function handleTaskControl(ctx: SessionContext, action: TaskControl["action"], taskId?: string): void {
  const tasks = ctx.agentDeps.tasks;
  if (!tasks) return;

  // «отмени» без явного taskId → снять ВСЕ задачи сессии (параллельный режим §20). С
  // явным taskId (кнопка в UI на конкретной задаче) — гранулярная отмена ниже.
  if (action === "cancel" && !taskId) {
    const cancelled = tasks.cancelSession(ctx.session.sessionId);
    ctx.voice.clearPendingSpeech(); // отменил всё → отложенные фоновые итоги тоже не нужны
    for (const t of cancelled) emitTaskStatus(ctx.session, t);
    const text =
      cancelled.length === 0 ? "Нет активной задачи." : cancelled.length > 1 ? "Остановил все, сэр." : "Остановил.";
    ctx.session.send("transcript", { text, final: true });
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
    const text = action === "status" ? "Сейчас ничего не выполняю." : "Нет активной задачи.";
    ctx.session.send("transcript", { text, final: true });
    return;
  }

  switch (action) {
    case "cancel": {
      const ok = tasks.cancel(task.taskId);
      emitTaskStatus(ctx.session, task);
      ctx.session.send("transcript", { text: ok ? "Остановил." : "Уже завершено.", final: true });
      ctx.session.send("client.state", { state: "idle" });
      break;
    }
    case "pause": {
      const ok = tasks.pause(task.taskId);
      emitTaskStatus(ctx.session, task);
      ctx.session.send("transcript", { text: ok ? "Поставил на паузу." : "Сейчас нельзя поставить на паузу.", final: true });
      break;
    }
    case "resume": {
      const ok = tasks.resume(task.taskId);
      emitTaskStatus(ctx.session, task);
      ctx.session.send("transcript", { text: ok ? "Продолжаю." : "Нечего возобновлять.", final: true });
      break;
    }
    case "status": {
      ctx.session.send("transcript", { text: statusReport(task), final: true });
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
    summary: task.goal,
    stepsDone: task.stepsDone,
    stepsTotal: task.stepsTotal,
  };
  session.send("task.status", payload);
}

// ── кодирование аудио для DEV-пути по WS (§5: в проде — WebRTC) ──────────

/** ArrayBuffer → base64 (speak.chunk по JSON-WS). */
function bufToBase64(buf: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buf)).toString("base64");
}

/** Нормализовать входящий pcm (base64-строка | массив | ArrayBuffer) в ArrayBuffer. */
function toArrayBuffer(pcm: unknown): ArrayBuffer {
  if (pcm instanceof ArrayBuffer) return pcm;
  if (typeof pcm === "string") return copyBytes(Buffer.from(pcm, "base64"));
  if (Array.isArray(pcm)) return copyBytes(Uint8Array.from(pcm as number[]));
  if (ArrayBuffer.isView(pcm)) {
    const v = pcm as ArrayBufferView;
    return copyBytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
  return new ArrayBuffer(0);
}

/** Скопировать байты в свежий ArrayBuffer (исключает SharedArrayBuffer из типа). */
function copyBytes(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}
