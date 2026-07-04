/**
 * Аудио в renderer (§3, §10): захват и воспроизведение живут ЗДЕСЬ, потому что
 * WebRTC AEC работает только внутри Chromium-пайплайна и режет собственный TTS —
 * иначе barge-in слышит сам себя. Микрофон горячий во время воспроизведения.
 *
 * Захват: getUserMedia(echoCancellation) → AudioWorklet (capture-processor) →
 * Int16 PCM кадры → main (jarvis.pushPcm). Воспроизведение: speak.chunk (base64) →
 * аккумуляция → decodeAudioData → WebAudio; barge-in мгновенно глушит источник.
 *
 * audio.frame по WS — dev-путь (§5); в проде PCM/воспроизведение идут по WebRTC (LiveKit).
 */

/**
 * §10 ТИХИЙ МИКРОФОН (фикс «пустые транскрипты Deepgram» и «отпечаток снят с тишины → оглох»):
 * сырой пик мика бывает 0.01–0.04 даже на речи. AGC браузера ВЫКЛ (он коллапсировал, см. start()).
 * Ставим ФИКСИРОВАННЫЙ makeup через tanh-кривую: малый сигнал усиливается ≈×MIC_MAKEUP_GAIN (почти
 * линейно), громкий — мягко насыщается < 1 (без жёсткого клиппинга ворклета на ±1). НЕ адаптивный —
 * усиление стабильно навсегда (в отличие от AGC). Один тракт для STT, VAD и верификатора диктора.
 */
const MIC_MAKEUP_GAIN = 6;
function micMakeupCurve(k = MIC_MAKEUP_GAIN, n = 4096): Float32Array<ArrayBuffer> {
  // Явный ArrayBuffer (а не Float32Array(n)) — WaveShaperNode.curve требует Float32Array<ArrayBuffer>.
  const curve = new Float32Array(new ArrayBuffer(n * Float32Array.BYTES_PER_ELEMENT));
  for (let i = 0; i < n; i += 1) {
    const x = (i / (n - 1)) * 2 - 1; // вход -1..1
    curve[i] = Math.tanh(k * x);
  }
  return curve;
}

/** H18: бэкофф ретрая реинита захвата — устройство занято игрой, пробуем пока не отдадут. */
const RESTART_RETRY_MIN_MS = 1000;
const RESTART_RETRY_MAX_MS = 30_000;

/** Захват микрофона → PCM16 кадры. */
export class AudioCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  /** Watchdog заглохшего мика (§10): трек замьютился (устройство занято/сменилось) — реинит. */
  private muteTimer: ReturnType<typeof setTimeout> | null = null;
  private restarting = false;
  /** H18 (ревью 2026-07-02): таймер-ретрай реинита. После провала start() в restart() трека уже НЕТ
   * (stop() его убил) → события mute/ended больше НИКОГДА не придут, и без таймера Джарвис глох
   * НАВСЕГДА до перезапуска клиента (типовой кейс: игра с эксклюзивным аудио держит устройство,
   * getUserMedia кидает NotReadableError). Таймер — единственный путь ожить. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = RESTART_RETRY_MIN_MS;

  constructor(private readonly onFrame: (pcm: ArrayBuffer) => void) {}

  async start(): Promise<void> {
    if (this.ctx) return;
    // §10 КОРЕНЬ «слышит один раз и глохнет»: autoGainControl — ВРАГ голосового агента.
    // Первый ответ Джарвиса громко звучит в колонки, микрофон ловит эхо (горячий ради
    // barge-in). AGC срезает усиление под этот громкий вход, а в тихой комнате после TTS
    // НЕ восстанавливает его → 2-я фраза приходит на peak ~0.25 → Deepgram глух. Рестарт
    // getUserMedia сбрасывал AGC (поэтому «один раз слышал»). Фикс: AGC ВЫКЛ — усиление
    // микрофона стабильно навсегда. echoCancellation ОСТАВЛЯЕМ (гасит собственный TTS для
    // barge-in). noiseSuppression тоже выкл: APM-цепочка (NS+AGC) деформирует сигнал, а
    // облачный STT (Deepgram) сам шумоподавляет лучше. Так тракт устойчив «хоть год».
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
    // §10 устойчивость захвата: когда другое приложение (особенно игра с эксклюзивным аудио,
    // напр. Dota) занимает/сбрасывает аудиоустройство, трек микрофона МЬЮТИТСЯ и отдаёт тишину
    // (peak ~0.04) — Джарвис «перестаёт слышать», хотя кадры идут. Ловим mute/ended и
    // переинициализируем захват, если устройство не восстановилось.
    this.wireTrackResilience();
    // §10 STT: контекст СРАЗУ на 16кГц — браузер ресемплит микрофон КАЧЕСТВЕННО (с анти-алиасинг-
    // фильтром), а ворклет при ratio=1 становится чистым passthrough. Раньше ворклет сам ресемплил
    // 48к→16к «ближайшим сэмплом» БЕЗ фильтра → алиасинг: Deepgram nova-3 «не слышал» (пустой
    // транскрипт при здоровом уровне), хотя Whisper вытягивал. Chromium уважает этот rate.
    try {
      this.ctx = new AudioContext({ sampleRate: 16000 });
    } catch {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    // §10: контекст может «уснуть» при смене аудиоустройства (та же Dota) — будим обратно.
    this.ctx.onstatechange = () => {
      if (this.ctx?.state === "suspended") void this.ctx.resume().catch(() => {});
    };
    await this.ctx.audioWorklet.addModule("./audio-worklet.js");
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "capture-processor");
    this.node.port.onmessage = (ev: MessageEvent) => {
      this.onFrame(ev.data as ArrayBuffer);
    };
    // §10 makeup-gain тихого микрофона ПЕРЕД ворклетом: source → tanh-shaper → worklet.
    const makeup = this.ctx.createWaveShaper();
    makeup.curve = micMakeupCurve();
    makeup.oversample = "4x"; // меньше алиасинга от насыщения
    source.connect(makeup);
    makeup.connect(this.node);
    // Держим граф живым через нулевой gain (без слышимого эха).
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink);
    sink.connect(this.ctx.destination);
  }

  /**
   * §10 watchdog: повесить реакцию на mute/ended трека. Когда игра с эксклюзивным аудио
   * (Dota) занимает/сбрасывает устройство — трек либо `ended` (устройство ушло совсем),
   * либо `mute` (временно занят). На ended — сразу реинит. На mute — ждём 1.5с восстановления
   * (часто `unmute` приходит сам), и только если не вернулось — реинит. Иначе реинитили бы
   * на каждый кратковременный мьют (дёрганье графа, щелчки).
   */
  private wireTrackResilience(): void {
    const track = this.stream?.getAudioTracks()[0];
    if (!track) return;
    track.onended = () => void this.restart();
    track.onmute = () => {
      if (this.muteTimer) clearTimeout(this.muteTimer);
      this.muteTimer = setTimeout(() => void this.restart(), 1500);
    };
    track.onunmute = () => {
      if (this.muteTimer) {
        clearTimeout(this.muteTimer);
        this.muteTimer = null;
      }
    };
  }

  /** Полный реинит захвата (stop→start). Идемпотентен: повторные вызовы во время реинита — no-op. */
  private async restart(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    try {
      if (this.muteTimer) {
        clearTimeout(this.muteTimer);
        this.muteTimer = null;
      }
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      await this.stop();
      await this.start();
      this.retryDelayMs = RESTART_RETRY_MIN_MS; // ожил — бэкофф с начала
    } catch {
      // H18: устройство ещё не отдали (игра держит эксклюзивно). Трек уже убит stop() выше →
      // mute/ended не придут; чиним себя ТАЙМЕРОМ с бэкоффом, а не ждём события, которого не будет.
      await this.stop().catch(() => {}); // добить частично поднятый захват — не держать микрофон
      const delay = this.retryDelayMs;
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, RESTART_RETRY_MAX_MS);
      console.warn(`[audio] реинит микрофона не удался — повтор через ${delay}мс`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.restart();
      }, delay);
    } finally {
      this.restarting = false;
    }
  }

  async stop(): Promise<void> {
    if (this.muteTimer) {
      clearTimeout(this.muteTimer);
      this.muteTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.node?.port.close();
    this.node = null;
    await this.ctx?.close();
    this.ctx = null;
  }
}

/** Одна играющая озвучка — абстракция над <audio> (тестируемость очереди без DOM). */
export interface Utterance {
  /** Остановить воспроизведение (barge-in / сброс очереди). */
  stop(): void;
  /** Громкость 0..1 (живая регулировка голоса Джарвиса). */
  setVolume?(v: number): void;
}

/** Фабрика плеера: получает байты mp3 и колбэк «доиграл» (→ следующая в очереди). */
export type PlayerFactory = (bytes: Uint8Array<ArrayBuffer>, onEnded: () => void) => Utterance;

/** Дефолтный плеер: нативный <audio> + blob (надёжно для целого mp3). */
const defaultPlayer: PlayerFactory = (bytes, onEnded) => {
  const blob = new Blob([bytes], { type: "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  const el = new Audio(url);
  let revoked = false;
  const cleanup = (): void => {
    if (!revoked) {
      revoked = true;
      URL.revokeObjectURL(url);
    }
  };
  el.onended = () => {
    cleanup();
    onEnded();
  };
  el.onerror = () => {
    cleanup();
    onEnded();
  };
  void el.play().catch(() => {
    cleanup();
    onEnded();
  });
  return {
    stop() {
      try {
        el.pause();
      } catch {
        /* уже остановлен */
      }
      cleanup();
    },
    setVolume(v: number) {
      el.volume = Math.max(0, Math.min(1, v));
    },
  };
};

/**
 * Воспроизведение TTS пофразной ОЧЕРЕДЬЮ (§10 realtime). Реплика приходит несколькими
 * озвучками (по предложению), каждая завершается last=true. Раньше flush() звал stop()
 * и обрывал предыдущую фразу — теперь готовые озвучки кладутся в ОЧЕРЕДЬ и играются
 * подряд по onended. Barge-in/stop глушит текущую и чистит всю очередь.
 *
 * Каждая mp3-озвучка собирается из своих чанков (decodeAudioData рвал стрим-чанки,
 * потому склейка байтов + один <audio> на озвучку).
 */
export class AudioPlayback {
  private parts: Uint8Array<ArrayBuffer>[] = []; // чанки текущей принимаемой озвучки
  private queue: Uint8Array<ArrayBuffer>[] = []; // готовые озвучки, ждущие воспроизведения
  private current: Utterance | null = null;
  private active = false; // идёт ли воспроизведение прямо сейчас (для barge-in в «хвосте», §10)
  private volume = 1; // громкость голоса Джарвиса 0..1 (ползунок в настройках)

  // onActive(true/false) — реальный СТАРТ/КОНЕЦ звучания очереди. Нужен main, чтобы перебивание (§10)
  // работало, пока звук ЕЩЁ ИГРАЕТ, даже если сервер уже ушёл из speaking (синтез кончился раньше плеера).
  constructor(
    private readonly createPlayer: PlayerFactory = defaultPlayer,
    private readonly onActive?: (active: boolean) => void,
  ) {}

  private setActive(a: boolean): void {
    if (a === this.active) return;
    this.active = a;
    this.onActive?.(a);
  }

  /** Громкость голоса Джарвиса 0..1 (живая регулировка из настроек) — применяется и к текущей озвучке. */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.current?.setVolume?.(this.volume);
  }

  /** Принять чанк (audio — base64). На последнем — озвучка в очередь и (если простаиваем) старт. */
  enqueue(chunk: { audio: string; seq: number; last: boolean }): void {
    if (chunk.audio) this.parts.push(base64ToBytes(chunk.audio));
    if (chunk.last) {
      const merged = this.assemble();
      if (merged) {
        this.queue.push(merged);
        this.playNext();
      }
    }
  }

  /** Barge-in (§10): мгновенно заглушить текущую озвучку и очистить очередь. */
  stop(): void {
    this.parts = [];
    this.queue = [];
    if (this.current) {
      this.current.stop();
      this.current = null;
    }
    this.setActive(false); // звук оборван → main снимает barge-окно
  }

  /** Склеить чанки текущей озвучки в один буфер (и сбросить накопитель). */
  private assemble(): Uint8Array<ArrayBuffer> | null {
    if (this.parts.length === 0) return null;
    const total = this.parts.reduce((n, p) => n + p.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const p of this.parts) {
      merged.set(p, off);
      off += p.byteLength;
    }
    this.parts = [];
    return merged;
  }

  /** Запустить следующую озвучку, если сейчас ничего не играет. */
  private playNext(): void {
    if (this.current) return; // играет — следующая стартует по onEnded
    const bytes = this.queue.shift();
    if (!bytes) {
      this.setActive(false); // очередь пуста и ничего не играет → звук кончился
      return;
    }
    this.setActive(true); // звук пошёл (старт из простоя или следующая фраза)
    this.current = this.createPlayer(bytes, () => {
      this.current = null;
      this.playNext();
    });
    this.current.setVolume?.(this.volume); // применить выбранную громкость к этой озвучке
  }
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
