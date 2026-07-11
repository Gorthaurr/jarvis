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

/** §Волна3 ревью (#18): окно подавления «отставших» аудио-чанков после barge-in/stop (мс). Достаточно
 *  для in-flight WS-чанков отменённой фразы; новая фраза приходит секундами позже (вне окна). */
const STRAGGLER_SUPPRESS_MS = 400;

/** §Волна3 ревью (#17): сколько ждать следующий PCM-чанк после доигрывания хвоста, прежде чем счесть
 *  стрим умершим (last не пришёл) и завершить плеер по дренажу. Больше типовой паузы между чанками. */
const DRAIN_IDLE_MS = 2500;

/** Ревью фиксов Волны 3 (#6): пауза в PCM-потоке, после которой накопленные без last чанки считаются
 *  СИРОТОЙ оборванного стрима (v3 синтезирует ~реалтайм — внутри живой фразы таких пауз не бывает).
 *  Ревью 2-го прохода (R5): порог ОБЯЗАН быть строго больше серверного INACTIVITY_MS v3-стрима (8с,
 *  yandex-tts-v3.ts) + сеть — иначе честный «частичный last», который сервер шлёт ПОСЛЕ своего
 *  inactivity-аборта, приходил бы уже за порогом и сброс съедал бы доставленный партиал. */
const PCM_ORPHAN_MS = 12_000;

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

/** Дефолтный плеер: нативный <audio> + blob (надёжно для целого mp3).
 *  Волна 1: сервер шлёт earcon приёмки как WAV (RIFF) — сниффим магию, чтобы blob получил
 *  правильный MIME (audio/wav), а не «mp3 по умолчанию». */
const defaultPlayer: PlayerFactory = (bytes, onEnded) => {
  const isWav = bytes.length > 3 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46; // "RIFF"
  const blob = new Blob([bytes], { type: isWav ? "audio/wav" : "audio/mpeg" });
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
  // §Волна3 (3.5): PCM-стрим v3 — живой плеер, играющий чанки ПО МЕРЕ ПРИХОДА (WebAudio), когда
  // канал свободен; занят → чанки копятся и оформляются WAV-озвучкой в обычную очередь.
  private live: PcmLivePlayer | null = null;
  private pcmParts: Uint8Array<ArrayBuffer>[] = [];
  private pcmRate = 22_050;
  // Ревью фиксов Волны 3 (#6): когда в pcmParts последний раз клали чанк — для сброса СИРОТЫ
  // (last оборванной фразы потерян с WS → накопитель жил бы вечно, гейт #16 уводил бы следующую
  // фразу в busy-ветку, и её WAV склеивался бы с чужой головой).
  private pcmPartsAt = 0;
  // §Волна3 ревью (#18): окно подавления «отставших» чанков после barge-in/stop. Чанк, ушедший с
  // сервера ДО обработки cancelTts, доезжает через несколько мс ПОСЛЕ stop() — в v3 он немедленно
  // создавал новый живой плеер и играл обрывок отменённой фразы поверх речи юзера (+ взводил barge-окно
  // и повисал без last). Новая ЛЕГИТИМНАЯ фраза приходит лишь через секунды (новый ход) — окно её не задевает.
  private suppressChunksUntil = 0;

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

  /** Принять чанк (audio — base64). На последнем — озвучка в очередь и (если простаиваем) старт.
   *  §Волна3 (3.5): чанк format="pcm16" (v3 TTS-стрим) играется ПО МЕРЕ ПРИХОДА (см. enqueuePcm). */
  enqueue(chunk: { audio: string; seq: number; last: boolean; format?: string; sampleRate?: number }): void {
    // §Волна3 ревью (#18): «отставший» чанк отменённой фразы (пришёл в окне после stop()) — игнорируем,
    // чтобы он не зазвучал поверх речи юзера и не создал повисший live-плеер. Легитимная новая фраза
    // приходит секундами позже (новый ход), вне окна.
    if (Date.now() < this.suppressChunksUntil) return;
    if (chunk.format === "pcm16") {
      this.enqueuePcm(chunk);
      return;
    }
    if (chunk.audio) this.parts.push(base64ToBytes(chunk.audio));
    if (chunk.last) {
      const merged = this.assemble();
      if (merged) {
        this.queue.push(merged);
        this.playNext();
      }
    }
  }

  /**
   * §Волна3 (3.5): PCM16-стрим. Канал свободен → живой WebAudio-плеер играет чанки СРАЗУ (в этом
   * весь выигрыш латентности v3: не ждём конца синтеза). Занят (фраза уже играет/очередь) → чанки
   * копятся и на last оформляются WAV-озвучкой в общую очередь (штатный путь, без потери звука).
   */
  private enqueuePcm(chunk: { audio: string; last: boolean; sampleRate?: number }): void {
    const rate = chunk.sampleRate ?? this.pcmRate;
    this.pcmRate = rate;
    // Ревью фиксов (#6): сирота — прошлый стрим оборвался без last (WS-блип; сервер чанки не ресылает,
    // клиент на reconnect playback не сбрасывает). Пауза в потоке больше порога = это НЕ продолжение
    // той фразы: сбрасываем, иначе следующая фраза при полном простое ушла бы в busy-ветку (#16-гейт)
    // и в её WAV склеилась бы голова прошлой (возможно отменённой) реплики.
    // R5: last НЕ сбрасываем никогда — поздний last принадлежит ТОМУ ЖЕ стриму, что и накопленное
    // (чанки новой фразы, приди они раньше, сами сбросили бы сироту): это честный «частичный итог»
    // сервера после его inactivity-аборта, партиал обязан прозвучать, а не молча исчезнуть.
    if (!chunk.last && this.pcmParts.length > 0 && Date.now() - this.pcmPartsAt > PCM_ORPHAN_MS) {
      console.warn("[audio] осиротевшие PCM-чанки без last сброшены (прошлый стрим оборвался)");
      this.pcmParts = [];
    }
    const bytes = chunk.audio ? base64ToBytes(chunk.audio) : null;
    if (this.live) {
      if (bytes?.length) this.live.feed(bytes, rate);
      if (chunk.last) {
        this.live.markLast();
        this.live = null; // хвост доиграет сам и дёрнет playNext через onEnded
      }
      return;
    }
    // §Волна3 ревью (#16): fresh live-плеер стартуем ТОЛЬКО когда реально простаиваем И ничего не
    // накоплено. Раньше проверки pcmParts.length НЕ было: если фраза 1 доиграла ПОСРЕДИ приёма фразы 2
    // (current=null, queue пуста), следующий чанк фразы 2 создавал НОВЫЙ плеер, игравший только хвост, —
    // накопленная голова фразы (pcmParts) терялась и позже склеивалась с ЧУЖОЙ фразой. Есть накопленное →
    // идём в busy-ветку (копим дальше, на last соберём цельную WAV-озвучку) — ни один сэмпл не теряется.
    if (!this.current && this.queue.length === 0 && this.pcmParts.length === 0) {
      this.setActive(true);
      const lp = new PcmLivePlayer(rate, () => {
        if (this.current === lp) this.current = null;
        if (this.live === lp) this.live = null;
        this.playNext();
      });
      lp.setVolume(this.volume);
      this.current = lp;
      this.live = lp;
      if (bytes?.length) lp.feed(bytes, rate);
      if (chunk.last) {
        lp.markLast();
        this.live = null;
      }
      return;
    }
    if (bytes?.length) {
      this.pcmParts.push(bytes);
      this.pcmPartsAt = Date.now(); // (#6) отметка живости потока — сирота ловится по паузе
    }
    if (chunk.last) {
      const merged = mergeParts(this.pcmParts);
      this.pcmParts = [];
      if (merged) {
        this.queue.push(wavFromPcm16(merged, rate));
        this.playNext();
      }
    }
  }

  /** Barge-in (§10): мгновенно заглушить текущую озвучку и очистить очередь. */
  stop(): void {
    this.parts = [];
    this.queue = [];
    this.pcmParts = [];
    this.live = null; // current.stop() ниже закроет живой PCM-плеер (это тот же объект)
    if (this.current) {
      this.current.stop();
      this.current = null;
    }
    // §Волна3 ревью (#18): подавляем «отставшие» чанки отменённой фразы на короткое окно (см. поле).
    this.suppressChunksUntil = Date.now() + STRAGGLER_SUPPRESS_MS;
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

/** Склеить массив байт-кусков в один буфер (null на пустом входе). */
function mergeParts(parts: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> | null {
  if (parts.length === 0) return null;
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    merged.set(p, off);
    off += p.byteLength;
  }
  return merged;
}

/**
 * §Волна3 (3.5): обернуть сырой PCM16 (mono, little-endian) в WAV — чтобы штатный <audio>-плеер
 * (defaultPlayer уже сниффит RIFF с Волны 1) сыграл собранную озвучку из очереди. Чистая функция.
 */
export function wavFromPcm16(pcm: Uint8Array<ArrayBuffer>, sampleRate: number): Uint8Array<ArrayBuffer> {
  const header = new ArrayBuffer(44);
  const dv = new DataView(header);
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) dv.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  dv.setUint32(4, 36 + pcm.byteLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true); // размер fmt-блока
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // байт/сек (16 бит mono)
  dv.setUint16(32, 2, true); // блок-выравнивание
  dv.setUint16(34, 16, true); // бит на сэмпл
  str(36, "data");
  dv.setUint32(40, pcm.byteLength, true);
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

/**
 * §Волна3 (3.5): живой PCM-плеер — играет чанки v3-стрима ПО МЕРЕ ПРИХОДА через WebAudio
 * (курсор-планирование: каждый чанк стартует встык за предыдущим). Это и есть выигрыш
 * латентности стримингового TTS: первый звук — на первом чанке, не после всего синтеза.
 * stop() — barge-in (закрыть контекст); onEnded — когда прозвучал ХВОСТ после markLast().
 */
class PcmLivePlayer implements Utterance {
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private cursor = 0; // время (ctx.currentTime), до которого уже запланирован звук
  private pendingSources = 0;
  private lastSeen = false;
  private stopped = false;
  /** §Волна3 ревью (#21): нечётный хвостовой байт чанка — переносим в следующий, а не отбрасываем
   *  (иначе поток сдвигается на 1 байт → Int16 LE читается со сдвигом = шум до конца фразы). */
  private carry: Uint8Array<ArrayBuffer> | null = null;
  /** §Волна3 ревью (#17): дренаж-вотчдог — если last так и не пришёл (стрим v3 умер посреди фразы),
   *  плеер иначе НИКОГДА не завершится: current занят навсегда → onActive залип → barge-окно до 90с
   *  ловит речь юзера. Доиграли хвост и тишина дольше таймаута → честно завершаемся (освобождаем канал). */
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    sampleRate: number,
    private readonly onEnded: () => void,
  ) {
    this.ctx = new AudioContext({ sampleRate });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }

  /** Скормить очередной PCM16-чанк (mono LE). Планируется встык за уже запланированным. */
  feed(bytes: Uint8Array<ArrayBuffer>, sampleRate: number): void {
    if (this.stopped) return;
    this.clearDrainTimer(); // пришли новые данные — стрим жив
    // §Волна3 ревью (#21): склеиваем перенесённый нечётный байт с текущим чанком, ОБЩИЙ хвост — в carry.
    let data = bytes;
    if (this.carry && this.carry.byteLength) {
      const joined = new Uint8Array(this.carry.byteLength + bytes.byteLength);
      joined.set(this.carry, 0);
      joined.set(bytes, this.carry.byteLength);
      data = joined;
    }
    const n = Math.floor(data.byteLength / 2);
    this.carry = data.byteLength % 2 ? data.slice(n * 2) : null; // нечётный хвост — в следующий чанк
    if (n === 0) {
      // Ревью фиксов (#7/#13): clearDrainTimer выше снял вотчдог, а источника этот чанк не породил
      // (единственный байт ушёл в carry) — если хвост уже доигран и стрим умер на этом вырожденном
      // чанке, onended больше не случится → без повторного взвода плеер завис бы навсегда (#17 заново).
      if (this.pendingSources <= 0 && !this.lastSeen) this.armDrainTimer();
      return;
    }
    const dv = new DataView(data.buffer, data.byteOffset, n * 2);
    const f32 = new Float32Array(n);
    for (let i = 0; i < n; i += 1) f32[i] = dv.getInt16(i * 2, true) / 32768;
    const buf = this.ctx.createBuffer(1, n, sampleRate);
    buf.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    const startAt = Math.max(this.ctx.currentTime + 0.02, this.cursor);
    this.cursor = startAt + buf.duration;
    this.pendingSources += 1;
    src.onended = () => {
      this.pendingSources -= 1;
      if (this.pendingSources <= 0) {
        if (this.lastSeen) this.finish();
        else this.armDrainTimer(); // last не пришёл — ждём ещё чанк, иначе дренаж завершит (#17)
      }
    };
    try {
      src.start(startAt);
    } catch {
      this.pendingSources -= 1; // контекст уже закрыт (barge-in) — не зависаем на счётчике
    }
  }

  /** Стрим кончился (last=true): доигрываем запланированный хвост и завершаемся. */
  markLast(): void {
    this.lastSeen = true;
    this.clearDrainTimer();
    if (this.pendingSources <= 0) this.finish();
  }

  /** §Волна3 ревью (#17): взвести таймер завершения-по-тишине (last не пришёл, хвост доигран). */
  private armDrainTimer(): void {
    if (this.stopped || this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      if (!this.stopped && this.pendingSources <= 0) {
        console.warn("[audio] PCM-стрим не прислал last — завершаю по дренажу (освобождаю канал)");
        this.finish();
      }
    }, DRAIN_IDLE_MS);
  }

  private clearDrainTimer(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  private finish(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearDrainTimer();
    void this.ctx.close().catch(() => undefined);
    this.onEnded();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true; // barge-in: onEnded НЕ зовём (очередь чистит вызывающий)
    this.clearDrainTimer();
    void this.ctx.close().catch(() => undefined);
  }

  setVolume(v: number): void {
    this.gain.gain.value = Math.max(0, Math.min(1, v));
  }
}
