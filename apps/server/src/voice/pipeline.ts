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
  TtsOpts,
  TtsStream,
} from "../integrations/voice-providers.js";
import { stripAudioTags } from "../integrations/voice-providers.js";
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
import { isNoiseOnly, isWakeAddressed, stripWake } from "./wake.js";
import { PhraseSpeaker } from "./speak-session.js";
import type { FillerCache } from "./filler-cache.js";
import { buildAckEarconWav } from "./earcon.js";
import type { ISpeakerVerifier, VoiceProfile } from "./speaker/verifier.js";

/** Нормализация команды для анти-дубля: регистр/ё/пунктуация/пробелы — чтобы «Напиши Кате.» и
 * «напиши кате» считались одной командой (повтор/эхо не исполняем дважды). \b не знает кириллицу,
 * поэтому чистим по символьным классам Unicode. */
function dedupNorm(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Верификация диктора (§3 «kill-фича»): реагируем только на свои голоса. */
export interface SpeakerGateDeps {
  verifier: ISpeakerVerifier;
  /** Текущие enrolled-профили (функция — список меняется по мере записи новых голосов). */
  profiles: () => readonly VoiceProfile[];
}

/** Ответ brain в формате §21 (голос обязателен, карточка опциональна). */
export interface AgentReplyLike {
  voice: string;
  display?: { title?: string; markdown: string };
}

/**
 * Канал ПОФРАЗНОЙ выдачи реплики (§10 realtime). Brain зовёт sentence() по мере генерации,
 * done() — когда реплика готова целиком. Пайплайн синтезирует фразы и держит ОДНУ speaking-
 * сессию (speak_start один раз, speak_done один раз). Структурно совпадает с brain.ReplySink
 * (слои развязаны — как AgentReplyLike↔AgentReply).
 */
export interface ReplySink {
  /**
   * Brain начал «думать» (перед первым обращением к LLM, §10). Пайплайн на это играет
   * короткий прекеш-филлер «Секунду, сэр.» через ~250мс (если первая фраза не подоспела),
   * маскируя пол латентности Opus. Детерминированные пути (имя/режим) thinking НЕ зовут.
   */
  thinking?(): void;
  /** Готовое предложение голоса (уже вербализовано под TTS, §21) — синтезировать сразу. */
  sentence(text: string): void;
  /** Карточка подробностей (§21). */
  display(card: { title?: string; markdown: string }): void;
  /** Реплика сгенерирована целиком (full — весь голос для транскрипта/памяти). */
  done(full: string): void;
}

/** Задержка перед филлером (§10): если реальная реплика подоспела раньше — филлер не нужен. */
const FILLER_DELAY_MS = 250;

/** Интервал опроса семантического эндпоинта после паузы (§10): чаще → отзывчивее, но не спамим. */
const SILENCE_POLL_MS = 150;

/** §3: потолок буфера аудио хода для верификации диктора — ~8с @16кГц (хватает для опознания). */
const SPEAKER_BUFFER_CAP = 16_000 * 8;

/** Склеить кадры Int16 в один буфер (для верификации диктора). */
function concatInt16(chunks: readonly Int16Array[], total: number): Int16Array {
  const out = new Int16Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export interface VoicePipelineDeps {
  stt: ISttProvider;
  tts: ITtsProvider;
  /** Вызов brain на финальном тексте реплики (уже после verbalize внутри). */
  onUserTurn: (text: string) => Promise<AgentReplyLike>;
  /**
   * §10 realtime: стриминговый вариант — brain отдаёт реплику ПОФРАЗНО (token-streaming),
   * первый звук = синтез первого предложения. Если задан — используется вместо onUserTurn
   * (с автофолбэком на короткую реплику при ошибке brain). Реплика в 1 предложение по факту
   * = тот же путь, что и раньше (одна фраза → один синтез). undefined → классический onUserTurn.
   */
  onUserTurnStream?: (text: string, sink: ReplySink) => Promise<void>;
  /** Отправка аудио-чанка TTS клиенту (speak.chunk, §5). */
  sendSpeakChunk: (c: TtsChunk) => void;
  /** Уведомление клиента о состоянии (орб idle/listening/thinking/speaking). */
  sendClientState: (s: VoiceState) => void;
  /** Транскрипт для UI/логов (§5). */
  sendTranscript?: (t: { text: string; final: boolean }) => void;
  /** Реплика текстового чата (§22): роль+текст — для чат-вкладки и текстового фидбэка при mute. */
  sendChat?: (m: { role: "user" | "assistant"; text: string }) => void;
  /** Карточка подробностей (§21). */
  sendDisplay?: (d: { title?: string; markdown: string }) => void;
  turnDetector?: TurnDetector;
  followupMs?: number;
  sttSampleRate?: number;
  ttsVoiceId?: string;
  /**
   * Голос активного режима-маски (§11): вызывается на КАЖДЫЙ синтез — переключение
   * режима мгновенно меняет voiceId/подачу без пересоздания пайплайна. undefined → дефолт.
   */
  getVoiceOpts?: () => TtsOpts | undefined;
  /**
   * Прекеш-филлеры (§10 realtime): короткое «Секунду, сэр.» проигрывается, пока Opus думает
   * (~2с пол), маскируя латентность. undefined → без филлеров (голос как прежде).
   */
  filler?: FillerCache;
  /** Требовать обращение «Джарвис» вне активного разговора (§3 wake word). */
  requireWakeWord?: boolean;
  /** Окно активного разговора после реплики Джарвиса — продолжение без wake word (мс). */
  conversationWindowMs?: number;
  /** Верификация диктора (§3): реагировать только на свои голоса. undefined → гейт выключен. */
  speaker?: SpeakerGateDeps;
  /**
   * §9 «уважительная проактивность» (не мешать): занят ли пользователь СЕЙЧАС (звонок/полный экран/
   * блокировка) — из client.context. НЕсрочную проактивную речь (итоги фоновых задач) держим, пока
   * занят, и отдаём, когда освободится; срочную (напоминания-будильники) — пропускаем всегда.
   * undefined → считаем не занятым (поведение как раньше).
   */
  isUserBusy?: () => boolean;
  now?: () => number;
  log?: Logger;
}

export class VoicePipeline {
  private ctx: VoiceContext = initialContext();
  private sttStream: SttStream | null = null;
  private ttsStream: TtsStream | null = null;
  /** Активная пофразная говорящая сессия (§10 realtime); null вне стримингового ответа. */
  private phraseSpeaker: PhraseSpeaker | null = null;
  /** Таймер прекеш-филлера (§10): «Секунду, сэр.» пока Opus думает. */
  private fillerTimer: ReturnType<typeof setTimeout> | null = null;
  private followupTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly turn: TurnDetector;
  private readonly latency: LatencyTracker;
  private readonly now: () => number;
  private readonly followupMs: number;
  private readonly log: Logger;
  private interim = "";
  /** §3 верификация диктора: буфер PCM текущего хода (для опознания) + вердикт «не свой». */
  private readonly speaker?: SpeakerGateDeps;
  private turnAudio: Int16Array[] = [];
  private turnAudioSamples = 0;
  private speakerRejected = false;
  /**
   * §3: пометить ТЕКУЩИЙ STT-стрим как «не свой». Отдельно от speakerRejected (который сбрасывает
   * ensureStt следующего цикла): поздний реальный финал Deepgram приходит ПОСЛЕ переоткрытия STT,
   * и глобальный флаг к тому моменту уже сброшен → финал протекал мимо гейта. Closure-флаг стрима
   * это переживает. null вне открытого стрима.
   */
  private rejectActiveStream: (() => void) | null = null;
  /** Поколение оборота: поздние колбэки от устаревшего STT/TTS отбрасываются. */
  private gen = 0;
  /** Говорит ли сейчас пользователь (между speech_start и финалом) — не перебиваем его фоном. */
  private userSpeaking = false;
  /** Очередь озвучки фоновых результатов (§20 async): произносим, когда канал свободен (и юзер не занят, §9). */
  private pendingSpeech: { text: string; urgent: boolean }[] = [];
  /** Wake word (§3): активен ли разговор + когда было ПОСЛЕДНЕЕ взаимодействие (любая сторона). */
  private readonly requireWake: boolean;
  private readonly convWindowMs: number;
  private awake = false;
  /**
   * Время последней активности в разговоре — обновляется и когда говорит Джарвис, И когда
   * принята реплика пользователя (§3/§10). Окно разговора КАТИТСЯ: пока идёт диалог, Джарвис
   * слышит без повторного «Джарвис». Без этого окно отсчитывалось только от речи Джарвиса и
   * через 12с он «глох» посреди живого разговора (корневой симптом «слушает 5-10с и перестаёт»).
   */
  private lastActiveAt = 0;
  private lastCmd = ""; // анти-дубль: последняя обработанная команда + время
  private lastCmdAt = 0;

  constructor(private readonly deps: VoicePipelineDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.turn = deps.turnDetector ?? new TurnDetector(undefined, DEFAULT_TURN_CONFIG, this.now);
    this.latency = new LatencyTracker(this.now);
    this.followupMs = deps.followupMs ?? FOLLOWUP_WINDOW_MS;
    this.requireWake = deps.requireWakeWord ?? false;
    this.convWindowMs = deps.conversationWindowMs ?? 12_000;
    this.speaker = deps.speaker;
    this.log = deps.log ?? createLogger("voice:pipeline");
  }

  /**
   * Wake word (§3): вне активного разговора реагируем ТОЛЬКО на обращение «Джарвис».
   * Возвращает текст команды (без слова «Джарвис»), либо "" если реплика не к нам —
   * пустую строку редьюсер трактует как «игнор» (агент не будится).
   */
  private gateWake(raw: string): string {
    // §3 верификация диктора: ход признан «не своим» (музыка/чужой) — игнорируем СПЕКУЛЯТИВНУЮ
    // реплику. Поздний реальный финал режется отдельно — постримным флагом streamSpeakerRejected
    // в onPartial (этот глобальный флаг к приходу финала мог сброситься ensureStt следующего цикла).
    if (this.speakerRejected) {
      this.log.info("реплика отклонена верификацией диктора (не свой голос) — игнор");
      return "";
    }
    const t = raw.trim();
    if (!this.requireWake || t.length === 0) return t;
    let cmd: string | null = null;
    if (isWakeAddressed(t)) {
      this.awake = true;
      const c = stripWake(t);
      cmd = c.length > 0 ? c : t; // только «Джарвис» без команды — отдаём как есть
    } else if (this.awake && this.now() - this.lastActiveAt < this.convWindowMs) {
      // Без обращения — принимаем в КАТЯЩЕМСЯ окне активного разговора (см. lastActiveAt),
      // НО игнорируем чистые междометия («ах», «ох», «хм»…): это фоновый шум, не продолжение.
      if (!isNoiseOnly(t)) cmd = t;
    }
    if (cmd === null) {
      this.log.info("реплика без обращения «Джарвис» — игнор", { text: t.slice(0, 50) });
      return "";
    }
    // Анти-дубль: ту же команду не исполняем дважды в коротком окне (повтор пользователя / эхо /
    // interim+final / двойной STT-финал). Сравниваем НОРМАЛИЗОВАННО (регистр/ё/пунктуация/пробелы),
    // иначе «напиши Кате» и «Напиши Кате.» считались бы РАЗНЫМИ → задача выполнялась бы дважды
    // (жалоба «2 задачи дал, а это один повтор»). Окно 8с.
    const cmdNorm = dedupNorm(cmd);
    if (cmdNorm.length > 0 && cmdNorm === this.lastCmd && this.now() - this.lastCmdAt < 8_000) {
      this.log.info("дубль реплики (повтор/эхо) — игнор", { text: cmd.slice(0, 50) });
      return "";
    }
    // Реплика принята → продлеваем окно разговора (катится от КАЖДОГО взаимодействия, не
    // только от речи Джарвиса) — иначе диалог глохнет через convWindowMs после его ответа.
    this.lastActiveAt = this.now();
    this.lastCmd = cmdNorm;
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
   * (§11) и проактивность (§9). Стримит TTS-чанки клиенту; НЕ ждёт реплики юзера и НЕ
   * трогает машину состояний (drive=false): это «выстрелил и забыл», слух остаётся как был
   * (после приветствия мик доступен через wake-on-frame, как и раньше). Иначе приветствие
   * уводило бы цикл в speaking и churn'ило STT на старте сессии → «не слышит».
   */
  speak(text: string): void {
    this.startTts(text, this.gen, false);
  }

  /**
   * Озвучить РЕЗУЛЬТАТ фоновой задачи (§20 async): кладём в очередь и произносим, когда
   * канал свободен (не во время раздумья/речи Джарвиса и не поверх говорящего пользователя).
   * Так разговор не блокируется задачей, а её итог всё равно проговаривается по готовности.
   */
  speakQueued(text: string, urgent = false): void {
    if (!text.trim()) return;
    this.pendingSpeech.push({ text, urgent });
    this.maybeDrainSpeech();
  }

  /**
   * §9: отдать отложенную проактивную речь — зовётся при смене client.context (пользователь
   * освободился: вышел из звонка/полного экрана/разблокировал). Идемпотентно: пусто/занято → no-op.
   */
  drainPending(): void {
    this.maybeDrainSpeech();
  }

  private maybeDrainSpeech(): void {
    if (this.pendingSpeech.length === 0) return;
    if (this.ctx.state === "speaking" || this.ctx.state === "thinking") return;
    if (this.ttsStream || this.userSpeaking) return;
    // §10 realtime: пофразная сессия между фразами держит ttsStream=null, но канал ЗАНЯТ —
    // не вклиниваемся фоновым итогом посреди реплики.
    if (this.phraseSpeaker?.active) return;
    // §9 «не мешать»: пользователь занят (звонок/полный экран/блокировка) → отдаём только СРОЧНОЕ
    // (напоминания-будильники), несрочное (итоги фоновых задач) держим до освобождения.
    const busy = this.deps.isUserBusy?.() ?? false;
    const idx = busy ? this.pendingSpeech.findIndex((p) => p.urgent) : 0;
    if (idx < 0) return; // занят, срочного нет — держим, отдадим по drainPending при освобождении
    const [next] = this.pendingSpeech.splice(idx, 1);
    if (next) this.startTts(next.text, this.gen);
  }

  /**
   * Кадр PCM от клиента. Аудио доходит до сервера ТОЛЬКО после wake word
   * (§0.6/§3: клиент гейтит стрим), поэтому приход кадра в idle = активация цикла.
   */
  onAudioFrame(pcm: ArrayBuffer): void {
    if (this.ctx.state === "idle") this.onWake();
    // §10 САМО-ВОССТАНОВЛЕНИЕ ПРОСЛУШКИ: в listening STT мог закрыться, а состояние осталось
    // «слушаю» — эндпоинт без транскрипта (тишина/чужой → speech_end → close_stt), самозакрытие
    // Deepgram по простою, конец enrollment. Раньше переоткрытие было ТОЛЬКО из idle (onWake) →
    // кадры летели в закрытый стрим, Джарвис «глох» (клиент шлёт, сервер молчит). Переоткрываем
    // на следующей речи — ровно как обещает onClose «переоткроется на следующей речи».
    if (this.ctx.state === "listening" && !this.sttStream) this.ensureStt();
    // Кормим STT ТОЛЬКО в listening. Раньше кормили и в speaking → Джарвис
    // транскрибировал собственный TTS (эхо) → спам повторов/ответов. Barge-in
    // во время speaking всё равно работает по VAD-событию (speech_start → reducer).
    if (this.sttStream && this.ctx.state === "listening") {
      this.sttStream.pushAudio(pcm);
      // §3: копим аудио хода для верификации диктора (только когда гейт активен, иначе не тратим).
      if (this.speakerGateActive() && this.turnAudioSamples < SPEAKER_BUFFER_CAP) {
        const frame = new Int16Array(pcm.slice(0)); // копия: исходный буфер может переиспользоваться
        this.turnAudio.push(frame);
        this.turnAudioSamples += frame.length;
      }
    }
  }

  /** §3: активна ли верификация диктора (движок готов И есть хоть один записанный голос). */
  private speakerGateActive(): boolean {
    return Boolean(this.speaker?.verifier.ready) && (this.speaker?.profiles().length ?? 0) > 0;
  }

  /** §3: вердикт по накопленному аудио хода — «свой/чужой». true = пускаем (свой / не смогли решить). */
  private async checkSpeaker(): Promise<boolean> {
    if (!this.speaker || this.turnAudioSamples === 0) return true;
    const audio = concatInt16(this.turnAudio, this.turnAudioSamples);
    this.turnAudio = [];
    this.turnAudioSamples = 0;
    try {
      const match = await this.speaker.verifier.identify(audio, this.speaker.profiles());
      if (match === null) return true; // коротко/тихо/несовместимая модель — не запираем (пропускаем)
      // §3 Фаза 2: два порога. ≥accept → уверенно свой (пускаем); <reject → уверенно чужой (глушим);
      // зона [reject, accept) → «не решили» → fail-open (пускаем), чтобы просадка score (простуда/
      // шум/смена мик) не запирала владельца. Дельта accept−reject = анти-флап у границы.
      const accept = this.speaker.verifier.acceptThreshold;
      const reject = this.speaker.verifier.rejectThreshold;
      const ok = match.score >= reject; // глушим ТОЛЬКО уверенно чужого (< reject)
      const verdict = match.score >= accept ? "свой" : ok ? "не решили (пускаю)" : "чужой";
      this.log.info("верификация диктора", {
        name: match.name,
        score: Number(match.score.toFixed(3)),
        accept,
        reject,
        verdict,
        gender: match.gender, // §3 цель №2: пол по F0 (male/female/unknown)
        f0Hz: match.f0Hz != null ? Math.round(match.f0Hz) : undefined,
      });
      return ok;
    } catch (e) {
      this.log.warn("верификация диктора сорвалась — пропускаю ход", e instanceof Error ? e.message : String(e));
      return true; // сбой движка не должен запирать пользователя
    }
  }

  /** VAD-событие от клиента. */
  onVadEvent(state: "speech_start" | "speech_end" | "barge_in"): void {
    if (state === "speech_start") {
      this.userSpeaking = true; // пользователь заговорил — не лезем фоном
      this.turn.onSpeechStart();
      this.dispatch({ type: "speech_start" });
      return;
    }
    if (state === "barge_in") {
      this.userSpeaking = true;
      // H11: сообщаем редьюсеру, жив ли синтез. В listening (follow-up открыт STT) cancel_tts бампнул бы
      // gen и убил бы STT-стрим текущего хода → follow-up потерян; пусть шлёт cancel_tts только если есть
      // что глушить. В speaking/thinking редьюсер решает сам (флаг там не смотрится).
      const ttsActive = !!(this.ttsStream || this.phraseSpeaker?.active);
      this.dispatch({ type: "barge_in", ttsActive });
      return;
    }
    // speech_end: решение об эндпоинте — turn detector (§10).
    const decision = this.turn.onSpeechEnd();
    if (decision === "endpoint") {
      this.clearSilenceTimer();
      this.endpointTurn();
    } else {
      // Пауза, но мысль не закончена — ждём, с защитным таймером жёсткого эндпоинта.
      this.scheduleSilenceCheck();
    }
  }

  /**
   * Эндпоинт хода (§10 СКОРОСТЬ). Спекулятивный старт: interim-текст уже накоплен на стриме —
   * дёргаем агента СРАЗУ, не дожидаясь CloseStream+flush Deepgram (~200мс мёртвой паузы перед
   * первым токеном). Стрим всё равно закроется (close_stt из редьюсера), его поздний финал
   * проигнорируется (state уже thinking). Текста ещё нет → штатный speech_end (ждём реальный финал).
   */
  private endpointTurn(): void {
    if (!this.speakerGateActive()) {
      this.dispatchEndpoint();
      return;
    }
    // §3: вердикт диктора по аудио хода (десятки мс, параллельно тому, что уже отзвучало) — затем
    // штатный эндпоинт. gateWake применит speakerRejected (чужой → пустой транскрипт → игнор).
    // Гард поколения: за время await пользователь мог перебить (barge-in → cancelTts → gen++,
    // новый ход накапливает свой interim). Без гарда стейл-вердикт ПРОШЛОГО хода (а) пометил бы
    // speakerRejected/зарезал бы НОВЫЙ легитимный стрим, (б) dispatchEndpoint финализировал бы
    // чужой/недоговорённый interim. Поэтому устаревший вердикт молча отбрасываем.
    const myGen = this.gen;
    void this.checkSpeaker().then((ok) => {
      if (myGen !== this.gen) return; // перебили во время проверки — вердикт устарел
      this.speakerRejected = !ok;
      // Помечаем ТЕКУЩИЙ стрим: его поздний реальный финал зарежется, даже если к тому моменту
      // ensureStt следующего цикла уже сбросил speakerRejected (иначе финал протекал мимо гейта).
      if (!ok) this.rejectActiveStream?.();
      this.dispatchEndpoint();
    });
  }

  /** Спекулятивный/штатный эндпоинт (после возможной проверки диктора). */
  private dispatchEndpoint(): void {
    const speculative = this.interim.trim();
    if (speculative.length > 0) {
      this.dispatch({ type: "transcript_final", text: this.gateWake(speculative) });
    } else {
      this.dispatch({ type: "speech_end" });
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

  /** Сбросить очередь отложенных фоновых озвучек — на явный «стоп»/«отмени»: слушать стейл не нужно. */
  clearPendingSpeech(): void {
    this.pendingSpeech = [];
  }

  /** Освободить ресурсы (закрытие сессии). */
  dispose(): void {
    this.clearFollowup();
    this.clearSilenceTimer();
    this.cancelTts();
    this.pendingSpeech = []; // не держим отложенные фоновые реплики мёртвой сессии
    void this.sttStream?.close();
    this.sttStream = null;
  }

  // ── ядро: редьюсер + исполнение действий ───────────────────

  private dispatch(ev: VoiceEvent): void {
    const { context, actions } = reduce(this.ctx, ev);
    this.ctx = context;
    for (const a of actions) this.apply(a);
    // Страховка очереди озвучки (§20): на ЛЮБОМ переходе пробуем пролить отложенный фоновый
    // итог. Гарды maybeDrainSpeech делают это no-op при занятом канале → дешёво и идемпотентно.
    // Без этого итог застревал после barge-in/возврата в idle (нет speak_done → нет дренажа).
    this.maybeDrainSpeech();
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
        // idle = ничего не происходит → пользователь точно не в середине фразы. Сбрасываем
        // userSpeaking (иначе после ложного barge-in он застревал true и блокировал дренаж).
        if (a.state === "idle") this.userSpeaking = false;
        this.deps.sendClientState(a.state);
        break;
    }
  }

  // ── STT ────────────────────────────────────────────────────

  private ensureStt(): void {
    if (this.sttStream) return;
    this.interim = "";
    // §3: новый ход — сбрасываем буфер аудио и вердикт диктора (жил весь прошлый ход).
    this.turnAudio = [];
    this.turnAudioSamples = 0;
    this.speakerRejected = false;
    // §3: вердикт диктора ДЛЯ ЭТОГО стрима — переживает сброс speakerRejected следующим ensureStt,
    // поэтому поздний реальный финал отклонённого хода тоже зарежется (фикс протечки гейта).
    let streamSpeakerRejected = false;
    this.rejectActiveStream = () => {
      streamSpeakerRejected = true;
    };
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
      if (!p.final) return;
      // §3: ход уже признан «не своим» — режем и спекулятивный (через speakerRejected), и ПОЗДНИЙ
      // реальный финал (через streamSpeakerRejected — глобальный флаг к этому моменту мог сброситься).
      if (streamSpeakerRejected) {
        this.log.info("реплика отклонена верификацией диктора (поздний финал, не свой голос) — игнор");
        this.dispatch({ type: "transcript_final", text: "" });
        return;
      }
      this.dispatch({ type: "transcript_final", text: this.gateWake(p.text) });
    });
    stream.onError((e) => this.log.warn("ошибка STT-стрима", e.message));
    // Облачный STT (Deepgram) сам закрывает WS по простою (~10с без аудио). БЕЗ этого
    // сброса мёртвый стрим висит, ensureStt его не переоткрывает → Джарвис «глохнет»
    // после паузы. Локальный Whisper не самозакрывался, потому бага не было.
    stream.onClose(() => {
      if (this.sttStream === stream) {
        this.sttStream = null;
        this.log.info("STT-стрим закрылся — переоткроется на следующей речи");
      }
    });
    this.sttStream = stream;
  }

  private async finalizeStt(): Promise<void> {
    this.userSpeaking = false; // фраза пользователя завершена — канал может освободиться
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
    // §22 чат: реплика пользователя в историю (голосовой ход — что распознали).
    this.deps.sendChat?.({ role: "user", text });
    // §10 realtime: пофразный стрим, если brain его поддерживает (иначе — классический путь).
    if (this.deps.onUserTurnStream) {
      await this.runAgentStreaming(text, myGen);
      return;
    }
    let reply: AgentReplyLike;
    try {
      reply = await this.deps.onUserTurn(text);
    } catch (e) {
      this.log.error("ошибка brain", e instanceof Error ? e.message : String(e));
      reply = { voice: "Что-то пошло не так. Повторишь?" };
    }
    if (myGen !== this.gen) {
      // Юзер перебил, пока думали (barge-in на thinking) — этот ответ выбрасываем, но канал
      // мог освободиться: пробуем пролить отложенный фоновый итог (иначе застрял бы в очереди).
      this.maybeDrainSpeech();
      return;
    }
    this.latency.mark("llm_first_token");
    // Дисплей — без аудио-тегов интонации (они для v3-TTS, не для глаз); в TTS уходят с тегами.
    const replyText = stripAudioTags(reply.voice);
    this.deps.sendTranscript?.({ text: replyText, final: true });
    this.deps.sendChat?.({ role: "assistant", text: replyText }); // §22 чат: ответ в историю
    if (reply.display) this.deps.sendDisplay?.(reply.display);
    this.startTts(reply.voice, myGen);
  }

  /**
   * §10 realtime: ход на пофразном стриме. ОДНА speaking-сессия (PhraseSpeaker) на всю
   * реплику: speak_start один раз (первый звук первой фразы), speak_done один раз (после
   * последней). Барежит gen-инвалидацию (barge-in/stop): поздние фразы/чанки глохнут.
   * При ошибке brain — деградация на короткую реплику (без зависания в speaking).
   */
  private async runAgentStreaming(text: string, myGen: number): Promise<void> {
    // Джарвис заговорит → окно активного разговора (продолжение без wake word), как в startTts.
    this.awake = true;
    this.lastActiveAt = this.now();
    const speaker = new PhraseSpeaker({
      synthesize: (t) => this.deps.tts.synthesize(t, this.voiceOpts()),
      sendChunk: (c) => this.deps.sendSpeakChunk(c),
      onSpeaking: () => {
        this.latency.mark("tts_first_chunk");
        this.latency.mark("audio"); // первый звук пошёл к клиенту
        this.dispatch({ type: "speak_start" });
        this.log.info(`latency: ${this.latency.report().summary}`);
      },
      onDone: () => {
        this.phraseSpeaker = null;
        this.dispatch({ type: "speak_done" });
        this.maybeDrainSpeech(); // канал освободился — отложенный фоновый итог, если есть
      },
      isLive: () => myGen === this.gen,
      log: this.log,
    });
    this.phraseSpeaker = speaker;

    let pushedAny = false;
    const sink: ReplySink = {
      thinking: () => {
        // Brain пошёл к LLM (~2с пол Opus). Через FILLER_DELAY_MS играем «Секунду, сэр.»,
        // если реальная реплика не подоспела раньше — маскируем латентность (§10).
        if (myGen !== this.gen || pushedAny || this.fillerTimer || !this.deps.filler?.ready) return;
        this.fillerTimer = setTimeout(() => {
          this.fillerTimer = null;
          if (myGen === this.gen && !pushedAny) this.playFiller(myGen);
        }, FILLER_DELAY_MS);
        if (typeof this.fillerTimer.unref === "function") this.fillerTimer.unref();
      },
      sentence: (s) => {
        if (myGen !== this.gen) return;
        this.clearFillerTimer(); // реальная реплика пошла — отложенный филлер уже не нужен
        if (!pushedAny) {
          pushedAny = true;
          this.latency.mark("llm_first_token"); // первое предложение готово (≈ первый токен)
        }
        speaker.push(s);
      },
      display: (d) => {
        if (myGen !== this.gen) return;
        this.deps.sendDisplay?.(d);
      },
      done: (full) => {
        if (myGen !== this.gen) return;
        this.clearFillerTimer();
        // Дисплей — без аудио-тегов интонации (в TTS-фразы они уже ушли с тегами).
        const fullText = stripAudioTags(full);
        // ТИХИЙ ФИНАЛ (§20): пустой full = ход завершился БЕЗ произносимой фразы (фоновая задача
        // отдаст итог отдельно через speakResult). НЕ шлём пустой транскрипт/чат и НЕ форсим
        // «Готово.» — иначе на КАЖДОМ фоновом ходе звучала бы лишняя дворецкая фраза («×2 фразы»).
        // speaker.finish() без единой фразы эмитнет speak_done без speak_start → state.ts (thinking)
        // вернёт цикл в listening+followup БЕЗ звука: микрофон возвращается, лишней фразы нет.
        if (fullText.trim()) {
          this.deps.sendTranscript?.({ text: fullText, final: true });
          this.deps.sendChat?.({ role: "assistant", text: fullText }); // §22 чат: ответ в историю
          // Ничего не стримилось (детерминированный путь / 1-фразовая реплика) — произносим целиком.
          if (!pushedAny) {
            pushedAny = true;
            speaker.push(full.trim());
          }
        }
        speaker.finish();
      },
    };

    try {
      await this.deps.onUserTurnStream!(text, sink);
    } catch (e) {
      this.log.error("ошибка brain (stream)", e instanceof Error ? e.message : String(e));
      // brain упал, не вызвав done() → сами завершаем сессию, чтобы не зависнуть в speaking.
      if (myGen === this.gen) {
        if (!pushedAny) {
          const fb = "Что-то пошло не так. Повторишь?";
          this.deps.sendTranscript?.({ text: fb, final: true });
          speaker.push(fb);
        }
        speaker.finish();
      }
    }
    if (myGen !== this.gen) {
      // Перебили, пока генерировали — канал мог освободиться, пробуем пролить фоновый итог.
      this.maybeDrainSpeech();
    }
  }

  /** Прекеш earcon приёмки (Волна 1): собирается один раз при первом использовании. */
  private earconBuf: ArrayBuffer | null = null;

  /**
   * Волна 1 (эпизод 2026-07-10): мгновенная СЛЫШИМАЯ приёмка фоновой задачи — короткий тон
   * (~160мс), НЕ фраза («тихий финал» цел). Раньше приёмка молчала до отложенного ack (8с),
   * пользователь на ~6-й секунде решал «не услышал» и повторял команду → вторая петля.
   * Состояние голосовой машины НЕ трогаем (это не речь): микрофон продолжает слушать; клиентская
   * очередь воспроизведения играет тон немедленно. Выключатель: JARVIS_TASK_ACK_EARCON=0.
   */
  playTaskAckEarcon(): void {
    if (process.env.JARVIS_TASK_ACK_EARCON === "0") return;
    // Канал занят речью → доп. индикатор не нужен. Гард ПОЛНЫЙ (как maybeDrainSpeech, ревью B+C):
    // state=speaking И идущий TTS-стрим drive=false (проактив §9 не диспатчит speak_start), И
    // пофразная сессия между фразами (ttsStream=null, но канал занят). Клиентская сборка чанков —
    // единый аккумулятор: чужой last:true посреди мультичанк-стрима склеил бы битый блоб.
    if (this.ctx.state === "speaking" || this.ttsStream || this.phraseSpeaker?.active) return;
    this.earconBuf ??= buildAckEarconWav();
    // 1.8: earcon = ПЕРВАЯ обратная связь хода — отмечаем в latency-трекере (раньше фоновый ход
    // не производил звука до результата → «оборот неполный» и метрика приёмки не существовала).
    this.latency.mark("tts_first_chunk");
    this.latency.mark("audio");
    this.deps.sendSpeakChunk({ audio: this.earconBuf, seq: 0, last: true });
    this.log.info("приёмка: earcon отправлен (фоновая задача принята)", this.latency.report());
  }

  /**
   * §10 realtime: проиграть прекеш-филлер «Секунду, сэр.» как ПЕРВЫЙ звук, пока Opus думает.
   * Входим в speaking (как обычная речь); реальная реплика подъедет следом и встанет в
   * клиентскую очередь за филлером. Барежит gen (barge-in глушит и филлер, и реплику).
   */
  private playFiller(myGen: number): void {
    const audio = this.deps.filler?.pick();
    if (!audio || myGen !== this.gen) return;
    this.awake = true;
    this.lastActiveAt = this.now();
    this.latency.mark("tts_first_chunk");
    this.latency.mark("audio"); // первый звук (филлер) пошёл к клиенту
    this.dispatch({ type: "speak_start" }); // thinking → speaking
    this.deps.sendSpeakChunk({ audio, seq: 0, last: true });
    this.log.info("realtime: филлер проигран (маскировка пола латентности Opus)", this.latency.report());
  }

  private clearFillerTimer(): void {
    if (this.fillerTimer) {
      clearTimeout(this.fillerTimer);
      this.fillerTimer = null;
    }
  }

  /**
   * Синтез и стрим TTS. drive=true (ответ на ход / фоновый итог §20) — гонит машину
   * состояний speak_start→speaking→speak_done→listening+follow-up, чтобы по окончании
   * речи микрофон корректно переоткрылся. drive=false (проактивность/онбординг §9/§11) —
   * «выстрелил и забыл»: НЕ трогаем цикл, слух остаётся как был.
   */
  /** Опции синтеза: голос активного режима-маски (§11) поверх дефолтного voiceId. */
  private voiceOpts(): TtsOpts {
    const v = this.deps.getVoiceOpts?.();
    return {
      voiceId: v?.voiceId ?? this.deps.ttsVoiceId,
      stability: v?.stability,
      style: v?.style,
      speed: v?.speed,
      emotion: v?.emotion, // §21: эмоция подачи из профиля (роль TTS под активный голос)
    };
  }

  private startTts(voiceText: string, myGen: number, drive = true): void {
    // Джарвис заговорил → открываем окно активного разговора (продолжение без wake word).
    this.awake = true;
    this.lastActiveAt = this.now();
    const stream = this.deps.tts.synthesize(voiceText, this.voiceOpts());
    this.ttsStream = stream;
    let first = true;
    stream.onChunk((c) => {
      if (myGen !== this.gen) return;
      if (first) {
        first = false;
        this.latency.mark("tts_first_chunk");
        this.latency.mark("audio"); // первый звук пошёл к клиенту
        if (drive) this.dispatch({ type: "speak_start" });
        this.log.info(`latency: ${this.latency.report().summary}`);
      }
      this.deps.sendSpeakChunk(c);
    });
    stream.onError((e) => this.log.warn("ошибка TTS-стрима", e.message));
    stream.onDone(() => {
      if (myGen !== this.gen) return;
      this.ttsStream = null;
      if (drive) this.dispatch({ type: "speak_done" });
      this.maybeDrainSpeech(); // канал освободился — озвучим следующий фоновый результат, если есть
    });
  }

  private cancelTts(): void {
    this.gen += 1; // инвалидируем все колбэки текущего оборота (barge-in/stop)
    this.clearFillerTimer(); // §10: отложенный филлер тоже отменяем (barge-in во время раздумья)
    if (this.ttsStream) {
      this.ttsStream.cancel();
      this.ttsStream = null;
    }
    // §10 realtime: оборвать пофразную сессию (текущий синтез + очередь фраз) на barge-in/stop.
    if (this.phraseSpeaker) {
      this.phraseSpeaker.cancel();
      this.phraseSpeaker = null;
    }
  }

  // ── таймеры ────────────────────────────────────────────────

  private armFollowup(): void {
    // §разговор: окно «продолжения без wake» отсчитываем от момента, КОГДА ДЖАРВИС ЗАМОЛЧАЛ (вход в
    // follow-up), а НЕ от начала его речи. Иначе на длинном ответе convWindowMs истекал, ПОКА он ещё
    // говорил → твоя следующая реплika/уточнение падали как «без обращения» (жалоба «до конца не идёт,
    // дропает продолжение»). Теперь после его реплики у тебя полное окно на ответ без повторного «Джарвис».
    this.awake = true;
    this.lastActiveAt = this.now();
    this.clearFollowup();
    this.followupTimer = setTimeout(() => {
      this.followupTimer = null;
      this.dispatch({ type: "followup_timeout" });
      this.maybeDrainSpeech(); // вернулись в idle — можно озвучить отложенный фоновый итог
    }, this.followupMs);
    if (typeof this.followupTimer.unref === "function") this.followupTimer.unref();
  }

  private clearFollowup(): void {
    if (this.followupTimer) {
      clearTimeout(this.followupTimer);
      this.followupTimer = null;
    }
  }

  /**
   * Опрос эндпоинта после паузы (§10). Раньше был ОДИН таймер на maxSilenceMs → семантический
   * ранний эндпоинт не срабатывал НИКОГДА (первый speech_end меряет тишину ≈0 → «wait», а
   * единственная переоценка падала ровно на потолок 800мс). Теперь опрашиваем tick() начиная с
   * minSilenceMs и каждые SILENCE_POLL_MS: завершённая фраза (predictComplete≥порог) эндпоинтится
   * раньше → отзывчивее; незавершённая всё равно ждёт жёсткого потолка (tick вернёт endpoint там).
   */
  private scheduleSilenceCheck(): void {
    this.clearSilenceTimer();
    const poll = (): void => {
      this.silenceTimer = null;
      if (this.ctx.state !== "listening") return;
      if (this.turn.tick() === "endpoint") {
        this.endpointTurn();
        return;
      }
      this.silenceTimer = setTimeout(poll, SILENCE_POLL_MS);
      if (this.silenceTimer.unref) this.silenceTimer.unref();
    };
    this.silenceTimer = setTimeout(poll, Math.max(50, this.turn.minSilenceMs));
    if (this.silenceTimer.unref) this.silenceTimer.unref();
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}
