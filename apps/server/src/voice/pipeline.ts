/**
 * VoicePipeline — оркестратор голосового цикла (§10).
 *
 * Связывает: машину состояний (state.ts) + turn-detection (turn.ts) +
 * latency-трекер (latency.ts) + STT/TTS-провайдеры (voice-providers.ts) + brain.
 *
 * Поток (§10): wake → open STT → стрим аудио + interim-транскрипты → эндпоинт
 * (turn detector) → final → brain → стрим TTS (первый чанк ASAP) → speak.chunk
 * клиенту → конец → follow-up окно (мик горячий ~6с без wake word).
 * Barge-in: речь во время speaking → cancel TTS → снова listening.
 *
 * Один экземпляр на сессию. Редьюсер чист; здесь — все побочные эффекты и таймеры.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { FOLLOWUP_WINDOW_MS } from "@jarvis/protocol";
import type {
  ISttProvider,
  ITtsProvider,
  SttStream,
  TtsChunk,
  TtsStream,
} from "../integrations/voice-providers.js";
import { LatencyTracker } from "./latency.js";
import {
  type VoiceAction,
  type VoiceContext,
  type VoiceEvent,
  type VoiceState,
  initialContext,
  reduce,
} from "./state.js";
import { DEFAULT_TURN_CONFIG, TurnDetector } from "./turn.js";
import { isWakeAddressed, stripWake } from "./wake.js";

/** Ответ brain в формате §21 (голос обязателен, карточка опциональна). */
export interface AgentReplyLike {
  voice: string;
  display?: { title?: string; markdown: string };
}

export interface VoicePipelineDeps {
  stt: ISttProvider;
  tts: ITtsProvider;
  /** Вызов brain на финальном тексте реплики (уже после verbalize внутри). */
  onUserTurn: (text: string) => Promise<AgentReplyLike>;
  /** Отправка аудио-чанка TTS клиенту (speak.chunk, §5). */
  sendSpeakChunk: (c: TtsChunk) => void;
  /** Уведомление клиента о состоянии (орб idle/listening/thinking/speaking). */
  sendClientState: (s: VoiceState) => void;
  /** Транскрипт для UI/логов (§5). */
  sendTranscript?: (t: { text: string; final: boolean }) => void;
  /** Карточка подробностей (§21). */
  sendDisplay?: (d: { title?: string; markdown: string }) => void;
  turnDetector?: TurnDetector;
  followupMs?: number;
  sttSampleRate?: number;
  ttsVoiceId?: string;
  /** Требовать обращение «Джарвис» вне активного разговора (§3 wake word). */
  requireWakeWord?: boolean;
  /** Окно активного разговора после реплики Джарвиса — продолжение без wake word (мс). */
  conversationWindowMs?: number;
  now?: () => number;
  log?: Logger;
}

export class VoicePipeline {
  private ctx: VoiceContext = initialContext();
  private sttStream: SttStream | null = null;
  private ttsStream: TtsStream | null = null;
  private followupTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly turn: TurnDetector;
  private readonly latency: LatencyTracker;
  private readonly now: () => number;
  private readonly followupMs: number;
  private readonly log: Logger;
  private interim = "";
  /** Поколение оборота: поздние колбэки от устаревшего STT/TTS отбрасываются. */
  private gen = 0;
  /** Wake word (§3): активен ли разговор + когда Джарвис последний раз говорил. */
  private readonly requireWake: boolean;
  private readonly convWindowMs: number;
  private awake = false;
  private lastSpokeAt = 0;
  private lastCmd = ""; // анти-дубль: последняя обработанная команда + время
  private lastCmdAt = 0;

  constructor(private readonly deps: VoicePipelineDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.turn = deps.turnDetector ?? new TurnDetector(undefined, DEFAULT_TURN_CONFIG, this.now);
    this.latency = new LatencyTracker(this.now);
    this.followupMs = deps.followupMs ?? FOLLOWUP_WINDOW_MS;
    this.requireWake = deps.requireWakeWord ?? false;
    this.convWindowMs = deps.conversationWindowMs ?? 12_000;
    this.log = deps.log ?? createLogger("voice:pipeline");
  }

  /**
   * Wake word (§3): вне активного разговора реагируем ТОЛЬКО на обращение «Джарвис».
   * Возвращает текст команды (без слова «Джарвис»), либо "" если реплика не к нам —
   * пустую строку редьюсер трактует как «игнор» (агент не будится).
   */
  private gateWake(raw: string): string {
    const t = raw.trim();
    if (!this.requireWake || t.length === 0) return t;
    let cmd: string | null = null;
    if (isWakeAddressed(t)) {
      this.awake = true;
      this.lastSpokeAt = this.now();
      const c = stripWake(t);
      cmd = c.length > 0 ? c : t; // только «Джарвис» без команды — отдаём как есть
    } else if (this.awake && this.now() - this.lastSpokeAt < this.convWindowMs) {
      // Без обращения — принимаем лишь в окне активного разговора.
      cmd = t;
    }
    if (cmd === null) {
      this.log.info("реплика без обращения «Джарвис» — игнор", { text: t.slice(0, 50) });
      return "";
    }
    // Анти-дубль: ту же фразу не обрабатываем повторно в коротком окне (спам повторов).
    if (cmd === this.lastCmd && this.now() - this.lastCmdAt < 6_000) {
      this.log.info("дубль реплики — игнор", { text: cmd.slice(0, 50) });
      return "";
    }
    this.lastCmd = cmd;
    this.lastCmdAt = this.now();
    return cmd;
  }

  get state(): VoiceState {
    return this.ctx.state;
  }

  // ── вход извне ─────────────────────────────────────────────

  /** Wake word детектирован клиентом — активируем цикл. */
  onWake(): void {
    this.dispatch({ type: "wake" });
  }

  /**
   * Произнести произвольный текст вне пользовательского хода — онбординг-приветствие
   * (§11) и проактивность (§9). Стримит TTS-чанки клиенту; не ждёт реплики юзера.
   */
  speak(text: string): void {
    this.startTts(text, this.gen);
  }

  /**
   * Кадр PCM от клиента. Аудио доходит до сервера ТОЛЬКО после wake word
   * (§0.6/§3: клиент гейтит стрим), поэтому приход кадра в idle = активация цикла.
   */
  onAudioFrame(pcm: ArrayBuffer): void {
    if (this.ctx.state === "idle") this.onWake();
    // Кормим STT ТОЛЬКО в listening. Раньше кормили и в speaking → Джарвис
    // транскрибировал собственный TTS (эхо) → спам повторов/ответов. Barge-in
    // во время speaking всё равно работает по VAD-событию (speech_start → reducer).
    if (this.sttStream && this.ctx.state === "listening") {
      this.sttStream.pushAudio(pcm);
    }
  }

  /** VAD-событие от клиента. */
  onVadEvent(state: "speech_start" | "speech_end" | "barge_in"): void {
    if (state === "speech_start") {
      this.turn.onSpeechStart();
      this.dispatch({ type: "speech_start" });
      return;
    }
    if (state === "barge_in") {
      this.dispatch({ type: "barge_in" });
      return;
    }
    // speech_end: решение об эндпоинте — turn detector (§10).
    const decision = this.turn.onSpeechEnd();
    if (decision === "endpoint") {
      this.clearSilenceTimer();
      this.dispatch({ type: "speech_end" });
    } else {
      // Пауза, но мысль не закончена — ждём, с защитным таймером жёсткого эндпоинта.
      this.scheduleSilenceCheck();
    }
  }

  /** «Заткнись» — рубит TTS, задача (если есть) живёт; цикл в idle. */
  stop(): void {
    this.dispatch({ type: "stop" });
  }

  /** Честный mute (§0.6) — стоп захвата, в idle. */
  mute(): void {
    this.dispatch({ type: "mute" });
  }

  /** Освободить ресурсы (закрытие сессии). */
  dispose(): void {
    this.clearFollowup();
    this.clearSilenceTimer();
    this.cancelTts();
    void this.sttStream?.close();
    this.sttStream = null;
  }

  // ── ядро: редьюсер + исполнение действий ───────────────────

  private dispatch(ev: VoiceEvent): void {
    const { context, actions } = reduce(this.ctx, ev);
    this.ctx = context;
    for (const a of actions) this.apply(a);
  }

  private apply(a: VoiceAction): void {
    switch (a.type) {
      case "open_stt":
        this.ensureStt();
        break;
      case "close_stt":
        void this.finalizeStt();
        break;
      case "call_agent":
        void this.runAgent(a.text);
        break;
      case "cancel_tts":
        this.cancelTts();
        break;
      case "arm_followup":
        this.armFollowup();
        break;
      case "disarm_followup":
        this.clearFollowup();
        break;
      case "set_client_state":
        this.deps.sendClientState(a.state);
        break;
    }
  }

  // ── STT ────────────────────────────────────────────────────

  private ensureStt(): void {
    if (this.sttStream) return;
    this.interim = "";
    this.turn.reset();
    this.latency.reset();
    this.latency.mark("wake");
    const myGen = this.gen;
    const stream = this.deps.stt.open({
      sampleRate: this.deps.sttSampleRate ?? 16_000,
      language: "ru",
      interimResults: true,
    });
    stream.onPartial((p) => {
      if (myGen !== this.gen) return; // устаревший стрим
      this.interim = p.text;
      this.turn.onInterim(p.text);
      this.latency.mark("stt_first");
      this.deps.sendTranscript?.({ text: p.text, final: p.final });
      if (p.final) this.dispatch({ type: "transcript_final", text: this.gateWake(p.text) });
    });
    stream.onError((e) => this.log.warn("ошибка STT-стрима", e.message));
    this.sttStream = stream;
  }

  private async finalizeStt(): Promise<void> {
    const stream = this.sttStream;
    if (!stream) return;
    this.sttStream = null;
    this.latency.mark("turn_end"); // конец фразы пользователя (§10)
    try {
      await stream.close(); // финальный partial придёт в onPartial → transcript_final
    } catch (e) {
      this.log.warn("ошибка закрытия STT", e instanceof Error ? e.message : String(e));
    }
  }

  // ── brain → TTS ────────────────────────────────────────────

  private async runAgent(text: string): Promise<void> {
    const myGen = this.gen;
    if (this.latency.report().marks.turn_end === undefined) this.latency.mark("turn_end");
    let reply: AgentReplyLike;
    try {
      reply = await this.deps.onUserTurn(text);
    } catch (e) {
      this.log.error("ошибка brain", e instanceof Error ? e.message : String(e));
      reply = { voice: "Что-то пошло не так. Повторишь?" };
    }
    if (myGen !== this.gen) return; // юзер перебил, пока думали (barge-in на thinking)
    this.latency.mark("llm_first_token");
    this.deps.sendTranscript?.({ text: reply.voice, final: true });
    if (reply.display) this.deps.sendDisplay?.(reply.display);
    this.startTts(reply.voice, myGen);
  }

  private startTts(voiceText: string, myGen: number): void {
    // Джарвис заговорил → открываем окно активного разговора (продолжение без wake word).
    this.awake = true;
    this.lastSpokeAt = this.now();
    const stream = this.deps.tts.synthesize(voiceText, { voiceId: this.deps.ttsVoiceId });
    this.ttsStream = stream;
    let first = true;
    stream.onChunk((c) => {
      if (myGen !== this.gen) return;
      if (first) {
        first = false;
        this.latency.mark("tts_first_chunk");
        this.latency.mark("audio"); // первый звук пошёл к клиенту
        this.dispatch({ type: "speak_start" });
        this.log.info("latency (мс от конца фразы)", this.latency.report());
      }
      this.deps.sendSpeakChunk(c);
    });
    stream.onError((e) => this.log.warn("ошибка TTS-стрима", e.message));
    stream.onDone(() => {
      if (myGen !== this.gen) return;
      this.ttsStream = null;
      this.dispatch({ type: "speak_done" });
    });
  }

  private cancelTts(): void {
    this.gen += 1; // инвалидируем все колбэки текущего оборота (barge-in/stop)
    if (this.ttsStream) {
      this.ttsStream.cancel();
      this.ttsStream = null;
    }
  }

  // ── таймеры ────────────────────────────────────────────────

  private armFollowup(): void {
    this.clearFollowup();
    this.followupTimer = setTimeout(() => {
      this.followupTimer = null;
      this.dispatch({ type: "followup_timeout" });
    }, this.followupMs);
    if (typeof this.followupTimer.unref === "function") this.followupTimer.unref();
  }

  private clearFollowup(): void {
    if (this.followupTimer) {
      clearTimeout(this.followupTimer);
      this.followupTimer = null;
    }
  }

  /** Защитный таймер жёсткого эндпоинта, когда семантика сказала «ждать». */
  private scheduleSilenceCheck(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.ctx.state !== "listening") return;
      if (this.turn.tick() === "endpoint") this.dispatch({ type: "speech_end" });
    }, DEFAULT_TURN_CONFIG.maxSilenceMs);
    if (typeof this.silenceTimer.unref === "function") this.silenceTimer.unref();
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}
