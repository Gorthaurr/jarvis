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
  type ClientSystem,
  type ClientKeys,
  type ClientSettings,
  type ClientStateMsg,
  type ConfirmResult,
  type DemoSave,
  type DevText,
  type Envelope,
  type MessageType,
  type SkillSaved,
  type Takeover,
  type TaskControl,
  type VadEvent,
} from "@jarvis/protocol";
import { AsyncMutex, type Logger, Semaphore, type ThinkingEffort, type Tier, createLogger, envInt } from "@jarvis/shared";
import { type AgentDeps, type AgentReply, handleUserText } from "../brain/agent/index.js";
import { SessionWarmth } from "../brain/agent/warmth.js";
import { getMode } from "../brain/persona/modes.js";
import type { DynamicToolStore } from "../brain/tools/dynamic.js";
import { getProfile, setLanguage, setContext } from "../brain/profile.js";
import { DEFAULT_LIMITS, type SpendGuard, type SpendGuards } from "../billing/index.js";
import { setCredential } from "../db/credentials.js";
import type { ILlmProvider } from "../integrations/llm.js";
import type { EpisodicMemory } from "../memory/episodic.js";
import type { IEmbeddingProvider } from "../integrations/openai-embeddings.js";
import type { SemanticResponseCache } from "../brain/response-cache.js";
import type { IWebProvider } from "../integrations/web.js";
import type { ISttProvider, ITtsProvider, TtsChunk } from "../integrations/voice-providers.js";
import { isEmotion } from "../integrations/tts-emotion.js";
import type { ReminderService } from "../proactive/reminders/service.js";
import type { WatchService } from "../proactive/watch/service.js";
import type { AmbientEngine } from "../proactive/ambient/engine.js";
import type { ObligationStore } from "../proactive/ambient/obligations.js";
import type { ResolutionMemory } from "../memory/resolution-memory.js";
import { verbalize } from "../brain/verbalize/index.js";
import { WorkingMemory } from "../memory/working.js";
import { loadWorkingMemory } from "../memory/working-store.js";
import type { McpManager } from "../brain/mcp/manager.js";
import { noteClientContext } from "../proactive/salience.js";
import { TaskManager } from "../brain/tasks/manager.js";
import type { TradingService } from "../brain/trading/index.js";
import type { KnowledgeBase } from "../brain/knowledge/index.js";
import { saveDemonstratedSkill } from "../brain/skills/record.js";
import { type SkillProvider, hasGuardSteps, isLearnedMd, listSkills } from "../memory/skills.js";
import { type ReplySink, type VoicePipeline, createVoicePipeline } from "../voice/index.js";
import type { FillerCache } from "../voice/filler-cache.js";
import type { ISpeakerVerifier } from "../voice/speaker/verifier.js";
import type { VoiceProfileStore } from "../voice/speaker/store.js";
import type { HeartbeatHandle } from "./heartbeat.js";
import type { ExtensionBridge } from "./extension-bridge.js";
import type { Session } from "./session.js";
import { handleControlUtterance, handleTaskControl, handleTakeover } from "./task-control.js";
import { feedEnroll, sendVoiceList, startVoiceEnroll } from "./voice-enroll.js";

const log: Logger = createLogger("router-ws");

/** Голосовые провайдеры, общие на gateway (создаются один раз из конфига). */
export interface VoiceProviders {
  stt: ISttProvider;
  tts: ITtsProvider;
  voiceId?: string;
  /** Прекеш-филлеры (§10 realtime): «Секунду, сэр.» маскирует пол латентности Opus. */
  filler?: FillerCache;
  /** §3 верификация диктора: движок + хранилище голосов (общие на gateway). undefined → гейт выкл. */
  speakerVerifier?: ISpeakerVerifier;
  speakerStore?: VoiceProfileStore;
}

/** Мозговые провайдеры, общие на gateway (§7, §8, §12, §14). */
export interface BrainProviders {
  llm: ILlmProvider;
  episodic: EpisodicMemory;
  /** §15 семантический кэш чисто-вербальных ответов — общий на gateway (scoped по userId внутри). */
  responseCache: SemanticResponseCache;
  /** Эмбеддер (e5, с кешем) — семантический слой дубль-гейта §20 (Волна 1). Опционален. */
  embedder?: IEmbeddingProvider;
  web: IWebProvider;
  /** §6B/B5: реестр SpendGuard по userId (per-tenant траты + живой persist usage_quota). */
  spend: SpendGuards;
  models: Record<Exclude<Tier, "tier0">, string>;
  /** «Эффорт» рассуждения (thinking) по тиру (§7). */
  tierThinking: Record<Exclude<Tier, "tier0">, ThinkingEffort>;
  /** Реестр долгих задач (§20) — общий на gateway: голос/UI управляют активной задачей. */
  tasks: TaskManager;
  /** Тёплость сессий для §15-кеширования — общая на gateway. */
  warmth: SessionWarmth;
  /** Реестр самописных инструментов (§8+ саморасширение) — общий на gateway. */
  dynamicTools: DynamicToolStore;
  /** Провайдер выученных показом навыков (§8) — общий на gateway. */
  skills: SkillProvider;
  /** §трейдинг (слой 1): рыночные данные + анализ (только чтение) — общий на gateway. Опционален. */
  market?: TradingService;
  /** §экспертность: база знаний по доменам — общая на gateway. Опциональна. */
  knowledge?: KnowledgeBase;
  /** Мост к браузерному расширению (§6): невидимая отправка в Telegram и т.п. */
  extBridge: ExtensionBridge;
  /** Сервис напоминаний (§9): durable-таймер + проактивная озвучка — один на gateway. */
  reminders: ReminderService;
  /** Сервис наблюдений (§долгие-задачи): durable recurring-мониторинг + проактивная озвучка — один на gateway. */
  watch?: WatchService;
  /** Стор обязательств/счетов (§проактив-всё) — для инструментов obligation_*; ambient-движок читает его. */
  obligations?: ObligationStore;
  /** Движок ambient-осведомлённости (§проактив-всё): проактивно сообщает важное (счета/Telegram) — один на gateway. */
  ambient?: AmbientEngine;
  /** Опытная память резолва получателей (§ скорость) — одна на gateway, переживает рестарт. */
  resolutionMemory?: ResolutionMemory;
  /** §: MCP-host — подключённые MCP-серверы (инструменты как у Claude Code). Опционален (нет конфига → пуст). */
  mcp?: McpManager;
}

/** Потолок параллельных фоновых agent-loop'ов на сессию (§20): «много агентов», но не
 *  бесконечно (LLM/CPU). GUI-задачи всё равно сериализует аренда ввода; research-задачи
 *  бегут реально параллельно. */
// §20: потолок параллельных agent-loop'ов. 5 → 3: при 5 одновременных тяжёлых ходах Opus делит
// throughput, часть стримов упирается в watchdog (>25с без токена) → «связь прервалась» (нагруз-тест).
// 3 — баланс для одного пользователя (реально параллельных задач редко >2), меньше контеншена. Env-тюн.
const MAX_PARALLEL_TASKS = Math.max(1, Number.parseInt(process.env.JARVIS_MAX_PARALLEL_TASKS ?? "", 10) || 3);

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
  /** §3 верификация диктора: общие на gateway движок + хранилище голосов (для enrollment). */
  speakerVerifier?: ISpeakerVerifier;
  speakerStore?: VoiceProfileStore;
  /** §3: активная сессия записи отпечатка (между voice.enroll.start и stop/готово). */
  enroll?: { name: string; session: import("../voice/speaker/verifier.js").EnrollSession; sentPct: number };
  /**
   * Закрытие сессии (§20): помечаем закрытой (фоновый итог не озвучиваем в мёртвую
   * сессию) и снимаем её незавершённые задачи. Вызывается gateway по ws-close.
   */
  disposeAgent(): void;
}

/** §контекст: компактная сводка открытых вкладок браузера для live-хвоста промпта (с ♪ у звучащей). */
function formatTabsContext(
  tabs: ReadonlyArray<{ title?: string; host?: string; url?: string; active?: boolean; audible?: boolean }>,
): string {
  if (!tabs.length) return "";
  const cut = (s: string): string => (s.length > 42 ? `${s.slice(0, 41)}…` : s);
  const items = tabs.slice(0, 8).map((t) => {
    const name = cut(String(t.title || t.host || t.url || "?").trim());
    const flags = [t.active ? "активна" : "", t.audible ? "♪ звучит" : ""].filter(Boolean).join(", ");
    return flags ? `${name} (${flags})` : name;
  });
  return `Открытые вкладки браузера: ${items.join("; ")}`;
}

/** §: синтез TTS ЦЕЛИКОМ → base64 mp3 (для голосовых TG): копим чанки → склейка → base64. Голос — как
 *  у обычной речи (провайдер по умолчанию = филипп), отдельных opts не передаём. */
function synthTtsToBase64(tts: ITtsProvider, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const stream = tts.synthesize(text);
    stream.onChunk((c: TtsChunk) => {
      if (c.audio && c.audio.byteLength) chunks.push(new Uint8Array(c.audio));
    });
    stream.onError((e) => reject(e));
    stream.onDone(() => {
      const total = chunks.reduce((n, a) => n + a.length, 0);
      const buf = new Uint8Array(total);
      let off = 0;
      for (const a of chunks) {
        buf.set(a, off);
        off += a.length;
      }
      resolve(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("base64"));
    });
  });
}

/**
 * §6B/B5: отправить клиенту снимок расхода/лимитов (вкладка «Оплата»). Read-only — сервер считает,
 * клиент отображает. План — производная (нет платёжной системы, §0-p5): потолок выше дефолтного → «Pro».
 */
function sendUsage(session: Session, spend: SpendGuard): void {
  const s = spend.snapshot();
  const plan = s.cap > DEFAULT_LIMITS.spendCap ? "Pro" : "Базовый";
  session.send("usage.info", { plan, ...s });
}

/** Создать контекст для свежей/возобновлённой сессии. */
export function makeSessionContext(
  session: Session,
  heartbeat: HeartbeatHandle,
  providers: VoiceProviders,
  brain: BrainProviders,
): SessionContext {
  // §5 resume + персист: память диалога СКОУПЛЕНА на Session (переживает reconnect) И грузится С ДИСКА
  // по userId (переживает рестарт сервера/клиента) — иначе «забывал, о чём говорили». На новой сессии
  // поднимается из data/memory/<user>.json, дальше авто-сохраняется (см. working-store).
  const memory = session.scoped("workingMemory", () => loadWorkingMemory(session.userId));
  // H10: async-контур (§20) СКОУПЛЕН на Session (как workingMemory/toolActivation) → ПЕРЕЖИВАЕТ reconnect.
  // Раньше makeSessionContext создавал новый мьютекс/семафор/набор на КАЖДЫЙ коннект: команда на новом ctx
  // захватывала input-lease с ПОЛНЫМИ пермитами конкурентно с осиротевшей задачей старого ctx (в resume-grace
  // задача жива, см. H8) → ломалась single-writer GUI-сериализация и потолок параллельности. Теперь единые на
  // сессию: та же аренда ввода и тот же семафор видят и старую фоновую задачу, и команды после rebind.
  const inputArbiter = session.scoped("inputArbiter", () => new AsyncMutex()); // аренда мыши/клавы/фокуса — сериализует GUI-команды
  const concurrency = session.scoped("concurrency", () => new Semaphore(MAX_PARALLEL_TASKS)); // потолок параллельных agent-loop'ов
  const bgTasks = session.scoped("bgTasks", () => new Set<Promise<void>>()); // живые фоновые задачи (для чистки на закрытии)
  let closed = false;
  const agentDeps: AgentDeps = {
    memory,
    llm: brain.llm,
    episodic: brain.episodic,
    responseCache: brain.responseCache, // §15 семантический кэш ответов (lookup до LLM / store после)
    embedder: brain.embedder, // §20 Волна 1: семантический слой дубль-гейта (e5-косинус к целям задач)
    web: brain.web,
    models: brain.models,
    tierThinking: brain.tierThinking,
    spend: brain.spend.forUser(session.userId), // §6B/B5: гвард ЭТОГО юзера (траты не мешаются, persist живой)
    userId: session.userId,
    // Персистентный профиль (§8/§11, §6B/B3 — раздел этого userId): имя/факты в персону, чтобы
    // Джарвис ПОМНИЛ пользователя. Загружен в handshake (loadProfile) ДО makeSessionContext.
    userContext: {
      displayName: getProfile(session.userId).displayName,
      facts: getProfile(session.userId).facts,
      context: getProfile(session.userId).context, // §15: свободный контекст из настроек → в персону
      language: getProfile(session.userId).language,
    },
    tasks: brain.tasks, // общий реестр: «отмени» из UI мутирует флаг задачи в петле (§20)
    warmth: brain.warmth, // общая тёплость сессий (§15)
    dynamicTools: brain.dynamicTools, // §8+ самописные инструменты в наборе модели
    // §15 ленивая загрузка: набор подгруженных холодных инструментов — per-session (скоуплен на Session,
    // переживает reconnect). tool_load добавляет имена, агент включает их схемы со следующего хода.
    toolActivation: session.scoped("toolActivation", () => new Set<string>()),
    mcp: brain.mcp, // § MCP-host: инструменты подключённых MCP-серверов (холодный каталог + callTool)
    skills: brain.skills, // §8 выученные показом навыки (skill_list/skill_execute)
    market: brain.market, // §трейдинг: рыночные данные + анализ (только чтение)
    knowledge: brain.knowledge, // §экспертность: база знаний (свериться перед экспертной задачей)
    inputArbiter, // §20: GUI-команды (вкл. tier0) сериализуются, прочее — параллельно
    concurrency, // §20: ограничитель параллельных фоновых задач
    bgTasks, // §20: реестр живых фоновых задач
    isClosed: () => closed, // §20: не озвучивать итог в закрытую сессию
    // §6: невидимая отправка в Telegram через браузерное расширение (фоновая вкладка).
    telegramSend: (to, text) => brain.extBridge.telegramSend(to, text),
    telegramSendVoice: (to, audioB64) => brain.extBridge.telegramSendVoice(to, audioB64), // § голосовое голосом филиппа
    synthVoice: (text) => synthTtsToBase64(providers.tts, text), // § синтез TTS → base64 для голосовых

    // §: открыть URL в браузере пользователя через расширение С УЧЁТОМ открытых вкладок (фокус
    // существующей вместо дубля). Reject (нет расширения) → агент откатится на shell-open.
    openOrFocus: (url) => brain.extBridge.openOrFocus(url),
    // §: браузер пользователя через расширение для browser_open/read/act (его реальные вкладки/сессия).
    ext: brain.extBridge,
    reminders: brain.reminders, // §9: durable-напоминания + проактивная озвучка
    watch: brain.watch, // §долгие-задачи: durable наблюдение/мониторинг + проактивная озвучка
    obligations: brain.obligations, // §проактив-всё: счета/обязательства (инструменты obligation_*)
    resolutionMemory: brain.resolutionMemory, // §: опытная память резолва получателей (скорость)
  };
  // §9 «не мешать»: поздняя привязка к ctx — пайплайн читает занятость пользователя из client.context.
  let ctxForBusy: SessionContext | undefined;
  const voice = createVoicePipeline({
    stt: providers.stt,
    tts: providers.tts,
    ttsVoiceId: providers.voiceId,
    // §10 realtime: прекеш-филлер «Секунду, сэр.» маскировал пол латентности Opus, НО на
    // каждую реплику (включая болтовню) звучал как деферрал «погоди, занят» → Джарвис будто
    // отделывается, а не разговаривает (фидбэк пользователя). С быстрым STT (deepgram) пауза
    // Opus ~2с естественна и без заглушки. По умолчанию ВЫКЛ; включить: JARVIS_VOICE_FILLER=1.
    ...(process.env.JARVIS_VOICE_FILLER === "1" ? { filler: providers.filler } : {}),
    // §11: голос активного режима-маски — берётся на каждый синтез из профиля, поэтому
    // «будь дерзким» меняет подачу мгновенно (без пересоздания пайплайна).
    getVoiceOpts: () => {
      const p = getProfile(session.userId);
      const m = getMode(p.mode).voice;
      // §21 эмоция подачи — из профиля, НЕЗАВИСИМО от режима (даже у базового butler без voice).
      const emotion = isEmotion(p.emotion) ? p.emotion : undefined;
      if (!m && !emotion) return undefined;
      return { voiceId: m?.voiceId, stability: m?.stability, style: m?.style, speed: m?.speed, emotion };
    },
    // §3 wake word: «Джарвис» нужен только чтобы НАЧАТЬ разговор (или после долгой паузы).
    requireWakeWord: true,
    // §3 АДРЕСАЦИЯ: окна КОРОТКИЕ. Раньше 180с → после одного «Джарвис» он 3 минуты реагировал
    // на ЛЮБУЮ речь и встревал в разговор/narration (жалоба). Окна катятся от КАЖДОЙ принятой
    // реплики — живой диалог не глохнет; но если ~20с не обращаешься, снова нужен «Джарвис».
    // followupMs — сколько мик «слушает» после ответа; conversationWindowMs — сколько можно
    // говорить без повторного «Джарвис» (см. pipeline.gateWake). Env-тюнятся (универсальность).
    // P1.4: followup 8→12с — даёт чуть больше времени ОТВЕТИТЬ после реплики Джарвиса (жалоба «не успел
    // договорить — перестал слушать»); риск barge-in низкий (окно только сразу после его речи, когда
    // ответ и так ожидаем). conversationWindowMs ОСТАВЛЕН 8с ОСОЗНАННО: 180с уже были и вызывали худшую
    // жалобу «3 минуты встревает в любую речь/нарратив»; корень (акустическое «обращено ли ко мне») —
    // отдельная большая задача (loopback-AEC + speaker-gate, нужен живой микрофон), не ползунок времени.
    followupMs: envInt("JARVIS_FOLLOWUP_MS", 12_000),
    conversationWindowMs: envInt("JARVIS_CONV_WINDOW_MS", 8_000),
    // §3 верификация диктора — РАЗВЯЗКА «движок» vs «фильтрация» (2026-06-24):
    //  • ДВИЖОК (sherpa в сайдкаре) поднимается по умолчанию (server.ts: JARVIS_SPEAKER_GATE!=="0") —
    //    чтобы РАБОТАЛА кнопка «Записать голос» в настройках (enroll нужен verifier+store).
    //  • РАНТАЙМ-ФИЛЬТРАЦИЯ (глушить «чужого») здесь — ТОЛЬКО при ЯВНОМ JARVIS_SPEAKER_GATE=1.
    //    Почему не авто-вкл по «есть записанный голос»: прежняя биометрия ЛОЖНО глушила САМОГО владельца
    //    (живой лог: score 0.03–0.7 при пороге 0.35 → 0.03 < reject 0.31 = «уверенно чужой» → оглох на
    //    хозяина). Авто-вкл оглушал бы владельца. Поэтому фильтрация — OPT-IN, пока биометрию не доведём
    //    (AS-Norm/банк векторов). Запись голоса при этом доступна всегда (движок есть).
    // Защита даже при =1: fail-open ([reject,accept)→пускаем, null→пускаем) + self-check на записи.
    ...(process.env.JARVIS_SPEAKER_GATE === "1" && providers.speakerVerifier && providers.speakerStore
      ? { speaker: { verifier: providers.speakerVerifier, profiles: () => providers.speakerStore!.list(session.userId) } }
      : {}),
    // §9 «уважительная проактивность»: занят ли пользователь СЕЙЧАС (звонок/полный экран/блокировка)
    // — несрочный фоновый итог держим до освобождения, срочное напоминание пропускаем (см. pipeline).
    isUserBusy: () => {
      const c = ctxForBusy?.lastContext;
      return Boolean(c && (c.micBusyByOtherApp || c.fullscreen || c.locked));
    },
    // brain на финальном тексте реплики (§21: {voice, display?}).
    onUserTurn: (text) => handleUserText(session, text, agentDeps),
    // §10 realtime: пофразный стрим реплики (token-streaming → первый звук раньше). Включён
    // по умолчанию; аварийный выключатель JARVIS_VOICE_STREAMING=0 → классический onUserTurn.
    ...(process.env.JARVIS_VOICE_STREAMING === "0"
      ? {}
      : {
          onUserTurnStream: (text: string, sink: ReplySink): Promise<void> =>
            handleUserText(session, text, agentDeps, sink).then(() => undefined),
        }),
    // speak.chunk: аудио по WS — DEV-путь (в проде WebRTC, §5). Кодируем в base64.
    sendSpeakChunk: (c: TtsChunk) =>
      session.send("speak.chunk", { audio: bufToBase64(c.audio), seq: c.seq, last: c.last }),
    sendClientState: (s) => session.send("client.state", { state: s }),
    sendTranscript: (t) => session.send("transcript", t),
    sendChat: (m) => session.send("chat", m), // §22 чат-история (роль+текст)
    sendDisplay: (d) => session.send("ui.display", d),
  });
  // §20 async: фоновые задачи не блокируют разговор — их ИТОГ озвучивается через
  // очередь пайплайна (когда канал свободен), плюс карточка в renderer.
  // Волна 1 (эпизод 2026-07-10): мгновенная слышимая ПРИЁМКА фоновой задачи — короткий earcon-тон,
  // не фраза. Убирает сам триггер повторов команды («8с тишины → не услышал → повторил → две петли»).
  agentDeps.taskAccepted = () => voice.playTaskAckEarcon();
  agentDeps.speakResult = (reply) => {
    voice.speakQueued(reply.voice);
    // §22: итог фоновой задачи — ТАКЖE в чат-историю (раньше уходил только голосом → в текст-канале
    // результат web/MCP/задач не появлялся; печатающий/в mute пользователь его не видел).
    if (reply.voice.trim()) session.send("chat", { role: "assistant", text: reply.voice });
    if (reply.display) session.send("ui.display", reply.display);
  };
  // §9 проактивная речь: когда сработает таймер напоминания — фраза идёт в ТУ ЖЕ очередь озвучки
  // (speakQueued произнесёт, когда канал свободен — не перебивая пользователя). Текст вербализуем
  // (числа/латиница), как обычные реплики. Снимаем регистрацию на закрытии сессии.
  // §9: напоминание — СРОЧНОЕ (будильник): озвучивается даже если пользователь занят (urgent=true).
  brain.reminders?.registerSpeaker(session.sessionId, session.userId, (text) => voice.speakQueued(verbalize(text), true));
  // §долгие-задачи: тот же канал проактивной речи для срабатываний наблюдений (мониторинг).
  brain.watch?.registerSpeaker(session.sessionId, session.userId, (text) => voice.speakQueued(verbalize(text), true));
  // §проактив-всё: ambient-осведомлённость (счета/Telegram). urgent (день оплаты) проходит даже при занятости.
  brain.ambient?.registerSpeaker(session.sessionId, session.userId, (text, urgent) => voice.speakQueued(verbalize(text), urgent));
  // §6B/B5: начальный снимок расхода/лимитов для вкладки «Оплата» (read-only; per-user SpendGuard).
  sendUsage(session, brain.spend.forUser(session.userId));
  // Отписать каналы проактивной озвучки ЭТОГО соединения (голосовой пайплайн умирает). Проактивные
  // события в grace-окне уйдут в pending и догонят владельца на reconnect (flushPending по userId).
  const detachSpeakers = (): void => {
    brain.reminders?.unregisterSpeaker(session.sessionId); // §9: больше не доставляем сюда
    brain.watch?.unregisterSpeaker(session.sessionId); // §долгие-задачи: больше не доставляем сюда
    brain.ambient?.unregisterSpeaker(session.sessionId); // §проактив-всё: больше не доставляем сюда
  };
  // H8: обрыв сокета (resume-grace) — НЕ убиваем фоновые §20-задачи. Раньше disposeAgent синхронно звал
  // cancelSession → reconnect в 120с находил задачу УБИТОЙ (результат потерян), хотя память цела. Теперь
  // на закрытии лишь отписываем озвучку этого соединения; задача живёт весь grace. Реальная отмена — в
  // finalTeardown (ниже), она навешена на Session.onTeardown и срабатывает лишь при РЕАЛЬНОМ удалении
  // сессии (grace истёк / shutdown), когда reconnect уже невозможен.
  const disposeAgent = (): void => {
    detachSpeakers();
  };
  // H8: финальная очистка сессии — отмена задач + глушение фонового итога. Выполняется registry.remove/
  // teardownAll через Session.teardown → onTeardown, а НЕ на каждом обрыве сокета.
  session.onTeardown(() => {
    closed = true;
    // Снимаем ВСЕ незавершённые задачи сессии одним проходом: петли увидят cancel-флаг, выйдут ≤1 шага
    // и освободят аренду ввода; задачи сами удалятся из bgTasks по завершении. Озвучку глушит isClosed().
    brain.tasks.cancelSession(session.sessionId);
    detachSpeakers(); // идемпотентно (могли уже отписать на grace-close)
  });
  const ctx: SessionContext = {
    session,
    memory,
    heartbeat,
    voice,
    agentDeps,
    disposeAgent,
    speakerVerifier: providers.speakerVerifier,
    speakerStore: providers.speakerStore,
  };
  ctxForBusy = ctx; // §9: пайплайн теперь видит client.context этой сессии
  return ctx;
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
      ctx.voice.drainPending(); // §9: освободился (вышел из звонка/полноэкранки) → отдать отложенный фоновый итог
      break;
    }
    case "client.state":
      log.debug("client.state", (env.payload as ClientStateMsg).state);
      break;
    case "task.control": {
      // Управление задачей из UI (кнопка «стоп»/«пауза»/«продолжить», §20).
      const c = env.payload as TaskControl;
      handleTaskControl(ctx, c.action, c.taskId, "ui");
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
    case "client.system": {
      // §контекст: живой снимок (окна/передний план/мониторы + ОТКУДА ЗВУК — с клиента) → некешируемый
      // хвост промпта. Сюда же добавляем ОТКРЫТЫЕ ВКЛАДКИ браузера (из расширения, с ♪-флагом звучащей),
      // чтобы Джарвис КАЖДЫЙ ХОД «видел» окна, вкладки и источник звука БЕЗ tool-call и без уточнений.
      const summary = (env.payload as ClientSystem).summary ?? "";
      let combined = summary;
      if (ctx.agentDeps.ext?.connected) {
        try {
          const r = (await ctx.agentDeps.ext.tabList()) as
            | { tabs?: Array<{ title?: string; host?: string; url?: string; active?: boolean; audible?: boolean }> }
            | undefined;
          const line = formatTabsContext(r?.tabs ?? []);
          if (line) combined = [summary, line].filter((s) => s && s.trim()).join(" · ");
        } catch {
          /* расширение не ответило — окна/звук всё равно в контексте */
        }
      }
      ctx.agentDeps.userContext = { ...ctx.agentDeps.userContext, systemContext: combined };
      break;
    }
    case "client.settings": {
      // §15: язык/контекст из настроек UI → персист в профиль + применяем к ТЕКУЩЕЙ сессии
      // сразу (не дожидаясь реконнекта). Ключи сюда не приходят (хранятся локально на клиенте).
      const s = env.payload as ClientSettings;
      if (typeof s.language === "string") void setLanguage(ctx.session.userId, s.language);
      if (typeof s.context === "string") void setContext(ctx.session.userId, s.context);
      ctx.agentDeps.userContext = {
        ...ctx.agentDeps.userContext,
        ...(typeof s.context === "string" ? { context: s.context } : {}),
        ...(typeof s.language === "string" ? { language: s.language } : {}),
      };
      log.info("client.settings: язык/контекст получены", { language: s.language, ctxLen: s.context?.length ?? 0 });
      break;
    }
    case "client.usage.request": {
      // §6B/B5: клиент (вкладка «Оплата») просит свежий снимок расхода/лимитов.
      sendUsage(ctx.session, ctx.agentDeps.spend);
      break;
    }
    case "client.keys": {
      // §6B/B4: API-ключи из UI → шифруем в user_credentials (per-user). Значения НЕ логируем.
      const k = env.payload as ClientKeys;
      const entries = Array.isArray(k?.keys) ? k.keys : [];
      for (const { service, value } of entries) {
        if (!service || !value) continue;
        void setCredential(ctx.session.userId, String(service), String(value)).then((ok) =>
          log.info("client.keys: ключ сохранён", { service, ok }),
        );
      }
      break;
    }
    // (sendUsage — модульный хелпер ниже)
    case "audio.frame": {
      const f = env.payload as AudioFrame;
      // §3: во время записи отпечатка тот же аудиопоток кормит enrollment, НЕ голосовой цикл.
      if (ctx.enroll) await feedEnroll(ctx, toArrayBuffer(f.pcm));
      else ctx.voice.onAudioFrame(toArrayBuffer(f.pcm));
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
    case "voice.enroll.start":
      startVoiceEnroll(ctx, (env.payload as { name: string }).name);
      break;
    case "voice.enroll.cancel":
      ctx.enroll?.session.cancel();
      ctx.enroll = undefined;
      break;
    case "voice.list":
      sendVoiceList(ctx);
      break;
    case "voice.remove":
      await ctx.speakerStore?.remove(ctx.session.userId, (env.payload as { name: string }).name);
      sendVoiceList(ctx);
      break;
    default:
      log.warn("необработанный тип входящего сообщения", { type });
  }
}

/** dev.text → агент → ответ клиенту (transcript + speak + опц. карточка). */
export async function onDevText(ctx: SessionContext, payload: DevText): Promise<void> {
  // Коэрсим в строку (defense-in-depth, §честность): не-строковый text (битый клиент/кривой кадр)
  // НЕ должен молча падать на text.trim — приводим к строке, иначе ход тихо теряется.
  const text = typeof payload?.text === "string" ? payload.text : String(payload?.text ?? "");
  if (!text.trim()) return;

  // Голосовое/текстовое управление задачей (§20): «отмени»/«пауза»/«продолжи»/«что
  // делаешь» перехватываем ДО агента, если есть активная задача. «стоп» (stop_tts)
  // рубит озвучку. Иначе — обычная реплика идёт в агент.
  // M7: dev.text — ТЕКСТОВЫЙ канал (вкладка «Чат»/dev-драйвер), ack НЕ озвучиваем (§22 text-silent).
  if (handleControlUtterance(ctx, text, "text")) return;

  ctx.session.send("chat", { role: "user", text }); // §22 чат: напечатанная реплика в историю
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
  // §20 тихий финал: пустая реплика = ход без произносимой фразы (фоновый итог придёт отдельно
  // через speakResult → свой chat). НЕ шлём пустой транскрипт/чат — иначе «пустой пузырь» в UI
  // и лишняя assistant-реплика помимо результата (та же «×2 фразы», но в текст-канале §22).
  if (reply.voice.trim()) {
    ctx.session.send("transcript", { text: reply.voice, final: true });
    ctx.session.send("chat", { role: "assistant", text: reply.voice }); // §22 чат: ответ в историю
  }
  if (reply.display) ctx.session.send("ui.display", reply.display);
  ctx.session.send("client.state", { state: "idle" });
  // Примечание: голосовой ответ (speak.chunk из TTS) идёт через VoicePipeline
  // на голосовом пути (audio.frame→STT→agent→TTS). Текстовый dev.text-путь
  // отдаёт только transcript/ui.display.
}

// ── управление задачами (§20) ──────────────────────────────────

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
