/**
 * Аудио-координация в main-процессе (§3, §10, §0.6).
 *
 * ВАЖНО (§3): захват И воспроизведение аудио ЖИВУТ В RENDERER (getUserMedia +
 * WebRTC AEC). main НЕ трогает аудиоустройства — он принимает PCM-кадры из renderer
 * (IPC), прогоняет wake word + VAD и ГЕЙТИТ стрим:
 *   - до wake word / push-to-talk аудио на сервер НЕ уходит (§0.6 privacy-инвариант);
 *   - после активации шлёт audio.frame + audio.vad;
 *   - barge-in (речь во время TTS) → сигнал renderer заглушить плеер (§10);
 *   - закрытие гейта при возврате сервера в idle (после follow-up окна §10).
 *
 * Сам PCM в проде идёт по WebRTC (LiveKit); audio.frame по WS — dev-заглушка (§5).
 */
import type { ClientState, VadEvent } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { type IWakeWord, MockWakeWord } from "../wakeword/index.js";
import { EnergyVad, type IVad, type VadSignal, rms } from "../vad/index.js";
import { type GateCloseKind, GateCloser } from "./gate-closer.js";
import { WakeMissMonitor } from "./wake-miss.js";

export interface AudioCoordinatorDeps {
  wakeword?: IWakeWord;
  vad?: IVad;
  /** Отправить кадр PCM на сервер (audio.frame, dev §5). */
  sendFrame: (pcm: Int16Array) => void;
  /** Отправить VAD-событие на сервер (audio.vad). */
  sendVad: (state: VadEvent["state"]) => void;
  /** Сообщить renderer состояние микрофона (горячий/закрыт) — индикация орба. */
  onMicState?: (open: boolean) => void;
  /** Сигнал renderer мгновенно заглушить плеер TTS (barge-in §10). */
  onBargeIn?: () => void;
  /** Часы (инъекция для тестов anti-echo grace §10); по умолчанию Date.now. */
  now?: () => number;
  log?: Logger;
}

/**
 * Окно «эхо-хвоста» после старта TTS (§10): первые мс речи поверх собственного TTS — почти
 * всегда не barge-in, а просочившееся сквозь AEC эхо Джарвиса. Не рубим TTS на нём, иначе
 * Джарвис давит сам себя на первом слове. Реальное перебивание длиннее этого окна.
 */
const BARGE_GRACE_MS = 250;

/**
 * Перебивание во время TTS ловим ЧУВСТВИТЕЛЬНЕЕ обычной прослушки (§10): громкий TTS из колонок
 * маскирует голос юзера, и обычный VAD-порог/онсет (700/3 кадра) может не поймать короткое
 * «тихо!»/«стоп». Здесь — ниже порог и быстрее онсет (эхо-окно + AEC отсекают ложные срабатывания).
 *
 * Порог СНИЖЕН 600→350 (живой лог 2026-06-19: barge_in НЕ срабатывал ни разу за 17 сессий речи —
 * браузерный echoCancellation при double-talk давит микрофон, гася вместе с эхом и голос юзера;
 * на 600 он не добивал). 0 ложных за те 17 сессий ⇒ остаточное эхо после AEC низкое, понижать
 * безопасно. Реальный уровень виден в логе «barge: пик rms за сессию речи» — по нему доводим.
 */
// Порог env-тюнится (JARVIS_BARGE_THRESHOLD), деф снижен 350→250 (чувствительнее; живой лог показывал
// пик 0 в большинстве сессий — юзер молчал — и редкие срабатывания). На наушниках можно ставить ниже.
const BARGE_THRESHOLD = (() => {
  const n = Number.parseInt(process.env.JARVIS_BARGE_THRESHOLD ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 250;
})();
/**
 * §10 (fix 2026-07-15, живой баг «не может озвучить длинную фразу / дать прогноз погоды»): barge-in
 * требует НЕПРЕРЫВНОГО превышения порога В ТЕЧЕНИЕ этого времени, а не N КАДРОВ. Раньше онсет = 2 кадра
 * (~20мс при 160 сэмплах/16кГц) → любой короткий спайк (реплика по ТВ, стук, эхо TTS сквозь несовершенный
 * AEC) на 20мс рвал речь; чем длиннее фраза, тем вероятнее спайк её оборвёт (прогноз погоды не дослушать).
 * Реальный barge («стоп/тихо») сплошной ≥200мс; интермиттентное эхо/шум с провалами между словами порог
 * ПО ВРЕМЕНИ не накопит (провал сбрасывает счётчик). env JARVIS_BARGE_SUSTAIN_MS (деф 200, кламп [40, 2000]).
 */
const BARGE_SUSTAIN_MS = (() => {
  const n = Number.parseInt(process.env.JARVIS_BARGE_SUSTAIN_MS ?? "", 10);
  return Number.isFinite(n) && n >= 40 && n <= 2000 ? n : 200;
})();
/**
 * §10: короткий провал ниже порога (микро-пауза между слогами РЕАЛЬНОЙ речи) НЕ сбрасывает отсчёт устойчивости
 * — иначе живой barge с дырами не накопил бы sustain и владелец не смог бы перебить вообще. Сброс — только на
 * СТОЙКОЙ тишине дольше этого (спайк кончился, речи не было). Деф 120мс (типичная межслоговая пауза < этого).
 */
const BARGE_GAP_TOLERANCE_MS = 120;
/**
 * §10 АДАПТИВНЫЙ порог barge (фикс «озвучивает 2 слова из фразы»): фиксированный порог рвал TTS от
 * ФОНОВОГО звука — играет Дота/музыка из колонок, browser-AEC внешний звук НЕ гасит (нет reference),
 * фон 300–2000 rms > 250 → каждый ответ Джарвиса обрывался «перебиванием» через пару слов. Держим
 * скользящий фон микрофона в ОБЫЧНОЙ прослушке (вне окна речи Джарвиса) и требуем от barge превышения
 * фона в K раз: тихая комната → эффективный порог остаётся чувствительным (250), шумный фон → порог
 * поднимается сам. env JARVIS_BARGE_OVER_AMBIENT (деф 2.5, ≥1).
 */
const BARGE_OVER_AMBIENT = (() => {
  const n = Number.parseFloat(process.env.JARVIS_BARGE_OVER_AMBIENT ?? "");
  return Number.isFinite(n) && n >= 1 ? n : 2.5;
})();
/** Сглаживание фона (EMA): медленное — залп в игре не должен мгновенно задирать порог. */
const AMBIENT_EMA_ALPHA = 0.05;
// Вместо «перебить РОВНО один раз за речь» — рефрактерный период: повтор возможен (первый barge мог быть
// ложным/ранним эхом), анти-дребезг сохранён.
const BARGE_REFRACTORY_MS = 500;
// Бэкстоп: playbackActive не должен «залипать» дольше этого (если renderer не прислал idle) — иначе
// обычная прослушка осталась бы выключенной. Реплика редко звучит дольше полутора минут.
const MAX_PLAYBACK_TAIL_MS = 90_000;

/**
 * W1: пре-ролл — кольцо последних кадров, пока гейт закрыт. Локальный wake срабатывает ~150 мс ПОСЛЕ
 * слова, и без пре-ролла облачный STT не услышал бы само «Джарвис» (и текстовый гейт сервера тоже).
 *
 * Ревью 2026-09-24 (B-F12): было 75 кадров (1,5 с). Кадр — 320 сэмплов = 20 мс (renderer/audio-worklet.js);
 * «Джарвис» звучит ~0,6 с, KWS срабатывает ~150 мс после конца слова → начало слова ~0,75 с назад.
 * 1,5 с тащили в STT ещё ~0,75 с звука ДО обращения (реплика ТВ, «ну вот»), а серверный stripWake
 * вырезает только само слово — «…по телевизору Джарвис, открой» уезжало командой «по телевизору открой».
 * 45 кадров = 0,9 с: слово целиком + ~150 мс запаса на медленное произношение. Даже если первый слог
 * срежется, реплика не потеряется: wake_local открывает на сервере окно адресации без слова в тексте.
 */
const PREROLL_FRAMES = 45;
/** W1: сервер в listening без РЕЧИ дольше этого → гейт закрыть (env JARVIS_LISTEN_IDLE_CLOSE_MS, деф 10 с). */
const LISTEN_IDLE_CLOSE_MS = (() => {
  const n = Number.parseInt(process.env.JARVIS_LISTEN_IDLE_CLOSE_MS ?? "", 10);
  return Number.isFinite(n) && n >= 2_000 ? n : 10_000;
})();
/**
 * Ревью 2026-09-24 (B-F3): жёсткий потолок открытого гейта без нового хода — речь его НЕ сдвигает.
 * Команда владельца укладывается (реплика ≤ 20 с, потолок энергетического VAD), а ТВ/Discord, в которых
 * VAD тоже видит речь, больше не держат гейт вечно. Производная от idle — отдельного флага не заводим.
 */
const LISTEN_HOLD_CAP_MS = LISTEN_IDLE_CLOSE_MS * 3;
/**
 * Ревью 2026-09-24 (B-F8): push-to-talk (кнопка микрофона / Ctrl+Alt+J) держит гейт столько, сколько
 * сервер держит окно адресации после wake_local (`LOCAL_WAKE_WINDOW_MS` в server/voice/pipeline.ts = 8 с):
 * дольше открытый гейт без адресации бесполезен — реплику без «Джарвис» сервер всё равно отбросит.
 */
const PTT_OPEN_MS = 8_000;
/** Кадр был недавно — захват в renderer жив (для честных логов «слух включён»). */
const CAPTURE_ALIVE_MS = 2_000;

export class AudioCoordinator {
  private wakeword: IWakeWord;
  private vad: IVad;
  private readonly log: Logger;
  private readonly now: () => number;
  private gateOpen = false;
  private serverSpeaking = false;
  /** W1: честный mute — кадры не обрабатываются ВООБЩЕ (в т.ч. локальным wake). */
  private muted = false;
  /** W1: гейт удерживается открытым (запись голосового отпечатка) — idle сервера его не закрывает. */
  private holdOpen = false;
  private lastServerState: ClientState = "idle";
  /** W1: пре-ролл кадров при закрытом гейте (см. PREROLL_FRAMES). */
  private preroll: Int16Array[] = [];
  /** §10 идёт ли СЕЙЧАС реальное воспроизведение TTS в renderer (хвост очереди после конца синтеза). */
  private playbackActive = false;
  private playbackActiveSince = 0;
  /** Когда сервер начал говорить (для anti-echo grace §10); 0 — не говорит. */
  private speakingSince = 0;
  /** §10 (fix 2026-07-15): МОМЕНТ начала превышения порога (устойчивость barge ПО ВРЕМЕНИ, не по кадрам —
   *  2 кадра = 20мс рвали длинные фразы от эхо/шум-спайка). 0 — отсчёта нет. */
  private bargeVoicedSince = 0;
  /** §10: момент ухода ниже порога ВНУТРИ отсчёта — короткий провал (микро-пауза речи) НЕ сбрасывает, сброс
   *  только на стойкой тишине >BARGE_GAP_TOLERANCE_MS (иначе микро-провалы речи мешали бы накопить sustain). */
  private bargeBelowSince = 0;
  private lastBargeAt = 0;
  /** §10 скользящий ФОН микрофона (EMA по кадрам обычной прослушки) — база адаптивного порога barge. */
  private ambientRms = 0;
  private bargeFrames = 0; // диагностика: кадры в barge-окне (для периодического лога пика)
  /** Пиковый rms микрофона за текущую сессию речи Джарвиса (диагностика порога barge-in §10). */
  private bargePeak = 0;
  private framesSent = 0; // диагностика потока кадров
  /**
   * Ревью 2026-09-24 (B-F3): сервер знает о речи владельца (speech_start / barge_in → userSpeaking=true),
   * а speech_end ещё не ушёл. Закрытие гейта в этом состоянии обязано досылать speech_end — иначе
   * userSpeaking на сервере залипает и фоновые итоги не звучат (их дренаж ждёт конца речи).
   */
  private speechOpen = false;
  /** Когда пришёл последний кадр из renderer (0 — ни одного): «слух включён» пишем только при живом захвате. */
  private lastIngestAt = 0;
  /** B-F3: закрытие гейта по тишине (речь сдвигает) + жёсткий потолок. */
  private readonly closer: GateCloser;
  /** B-F8: телеметрия «говорили при закрытом гейте, wake промолчал». */
  private readonly wakeMiss: WakeMissMonitor;

  constructor(private readonly deps: AudioCoordinatorDeps) {
    this.wakeword = deps.wakeword ?? new MockWakeWord();
    this.vad = deps.vad ?? new EnergyVad();
    this.log = deps.log ?? createLogger("audio");
    this.now = deps.now ?? (() => Date.now());
    this.closer = new GateCloser((kind) => this.onCloserFire(kind));
    this.wakeMiss = new WakeMissMonitor({ log: this.log, now: this.now });
  }

  get streaming(): boolean {
    return this.gateOpen;
  }

  /**
   * Push-to-talk / явная активация (когда реальный wake word недоступен, §18). `hold` — удерживать гейт
   * открытым несмотря на idle сервера (запись голосового отпечатка идёт вне хода); снять — release().
   */
  activate(opts: { hold?: boolean; ptt?: boolean } = {}): void {
    this.muted = false;
    if (opts.hold) this.holdOpen = true;
    // Ревью 2026-09-24 (B-F8): явный жест владельца «говорю» (кнопка микрофона) — push-to-talk,
    // а не «слушать Джарвис». Раньше при локальном wake activate() гейт не открывал вовсе: промах KWS
    // было нечем обойти.
    if (opts.ptt) {
      this.pushToTalk("button");
      return;
    }
    // W1: с локальным wake «включить слух» = слушать «Джарвис» на устройстве, а НЕ лить звук в облако.
    // Гейт откроет сам детектор (или удержание на запись голоса). Живой лог 2026-09-09: renderer звал
    // activate() при старте ПОСЛЕ подъёма слуха, и гейт оставался открытым до первого idle сервера.
    if (this.localWakeAvailable() && !opts.hold) {
      if (this.gateOpen && this.lastServerState === "idle") this.closeGate("activate-local-wake");
      // B-F4: «слух включён» — только при живом захвате; иначе честно: владелец разрешил, но кадров нет.
      if (this.captureAlive()) this.log.info("слух включён: локальный wake, гейт закрыт до «Джарвис»");
      else this.log.warn("микрофон разрешён владельцем, но кадров захвата нет — renderer ещё не поднял микрофон");
      return;
    }
    if (!this.gateOpen) this.openGate(opts.hold ? "manual-hold" : "manual");
  }

  /**
   * Ревью 2026-09-24 (B-F8): push-to-talk — кнопка микрофона или глобальная Ctrl+Alt+J. Открывает гейт
   * и шлёт серверу wake_local (окно адресации: реплика без «Джарвис» в тексте будет принята). При
   * локальном wake гейт закроется сам по тишине (PTT_OPEN_MS) — как после обычного «Джарвис».
   * Честный mute главнее жеста: красная кнопка «Джарвис не слышит» не должна врать — PTT не открывает.
   */
  pushToTalk(reason: string): boolean {
    if (this.muted) {
      this.log.warn("push-to-talk проигнорирован: микрофон выключен владельцем (mic-kill-switch)", { reason });
      return false;
    }
    if (!this.gateOpen) this.openGate(`ptt-${reason}`);
    this.deps.sendVad("wake_local");
    const inTurn = this.lastServerState === "thinking" || this.lastServerState === "speaking";
    if (this.localWakeAvailable() && !this.holdOpen && !inTurn) this.closer.arm(PTT_OPEN_MS, LISTEN_HOLD_CAP_MS);
    this.log.info("push-to-talk: гейт открыт, окно адресации у сервера", {
      reason,
      ms: PTT_OPEN_MS,
      capture: this.captureAlive() ? "кадры идут" : "кадров захвата нет — микрофон в renderer не поднят",
    });
    return true;
  }

  private captureAlive(): boolean {
    return this.lastIngestAt > 0 && this.now() - this.lastIngestAt < CAPTURE_ALIVE_MS;
  }

  /** W1: снять удержание (конец записи голоса); при idle сервера и локальном wake гейт закрывается. */
  release(): void {
    this.holdOpen = false;
    if (this.lastServerState === "idle" && this.localWakeAvailable() && !this.muted) this.closeGate("release-idle");
  }

  /** Локальный (акустический) wake доступен → гейт можно держать закрытым между ходами (§0.6). */
  localWakeAvailable(): boolean {
    return this.wakeword.ready;
  }

  /**
   * W1: подменить движки слуха (sherpa грузится асинхронно после boot). Если локальный wake появился,
   * а сервер простаивает — закрываем гейт: с этого момента звук уходит в облако только после «Джарвис».
   */
  setEngines(engines: { wake?: IWakeWord; vad?: IVad }): void {
    if (engines.wake) this.wakeword = engines.wake;
    if (engines.vad) this.vad = engines.vad;
    if (this.localWakeAvailable() && this.gateOpen && this.lastServerState === "idle" && !this.holdOpen) {
      this.closeGate("local-wake-ready");
    }
    this.log.info("движки слуха", { wakeReady: this.wakeword.ready, vad: this.vad.constructor.name });
  }

  /** Принять кадр PCM16 из renderer. */
  ingest(pcm: Int16Array): void {
    this.lastIngestAt = this.now();
    if (this.muted) return; // честный mute: ни в облако, ни в локальный wake
    if (!this.gateOpen) {
      // Гейт закрыт: аудио на сервер НЕ уходит (§0.6). Только wake word локально + пре-ролл в памяти.
      this.preroll.push(Int16Array.from(pcm));
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      const hit = this.wakeword.ready && this.wakeword.process(pcm);
      // B-F8: промах KWS больше не невидим — отдельный дешёвый детектор речи считает реплики без wake.
      if (!hit && this.wakeword.ready) this.wakeMiss.frame(pcm);
      if (hit) {
        this.openGate("wakeword");
        // Серверу: «обращение услышано локально» — следующая реплика принимается без «Джарвис» в тексте
        // (STT может ослышаться), затем пре-ролл (само слово «Джарвис» + начало команды), затем живой поток.
        this.deps.sendVad("wake_local");
        const frames = this.preroll;
        this.preroll = [];
        for (const f of frames) this.streamFrame(f);
        (this.wakeword as { reset?: () => void }).reset?.();
      }
      return;
    }
    this.streamFrame(pcm);
  }

  /** Сервер сообщил своё состояние (client.state): отслеживаем speaking. */
  setServerState(state: ClientState): void {
    this.lastServerState = state;
    const wasSpeaking = this.serverSpeaking;
    this.serverSpeaking = state === "speaking";
    // Засекаем момент старта речи для anti-echo grace (§10) — только на фронте idle→speaking.
    // И сбрасываем barge-детектор: перебить можно ОДИН раз за сессию речи Джарвиса.
    if (this.serverSpeaking && !wasSpeaking) {
      this.speakingSince = this.now();
      this.resetBargeSustain();
      this.lastBargeAt = 0;
      this.bargePeak = 0;
      this.bargeFrames = 0;
    } else if (!this.bargeWindowActive()) {
      // speaking→listening/idle и окно закрылось (звук не играет) → сброс отсчёта, чтобы стейл не пережил
      // разрыв до следующей фразы (ревью #close: короткий голос владельца перед закрытием → ложный barge).
      this.resetBargeSustain();
    }
    // §10 диагностика barge-in: на спаде speaking логируем, какого ПИКА достигал микрофон —
    // если пик << BARGE_THRESHOLD, AEC душит голос юзера и порог надо ронять ещё (или ты в колонках);
    // если перебил — fired. ВНИМАНИЕ: звук может ещё играть в хвосте (playbackActive) — barge там жив.
    if (!this.serverSpeaking && wasSpeaking) {
      this.log.info("barge: пик rms за сессию речи", {
        peak: Math.round(this.bargePeak),
        threshold: BARGE_THRESHOLD,
        fired: this.lastBargeAt >= this.speakingSince && this.lastBargeAt > 0,
        tailPlaying: this.playbackActive,
      });
    }
    // W1: ЕСТЬ локальный wake → на idle сервера гейт ЗАКРЫВАЕТСЯ: между ходами звук в облако не идёт,
    // «Джарвис» ловится на устройстве и открывает гейт с пре-роллом (§0.6 наконец по построению).
    // Без локального wake — прежнее поведение: НЕ закрываем на idle (иначе, как в §3 ambient, гейт
    // закрылся бы НАВСЕГДА — открыть некому — и Джарвис «глох» после первого ответа).
    if (state === "idle" && this.localWakeAvailable() && !this.holdOpen && !this.muted) this.closeGate("idle-local-wake");
    // Живой прогон 2026-09-09: в комнате с фоном (ТВ/Discord) сервер до idle НЕ доходит — VAD-события
    // держат его в listening бесконечно, и гейт не закрывался никогда. Поэтому закрываем и по ТАЙМЕРУ.
    // Окно follow-up владельца укладывается в этот срок; дальше — снова «Джарвис» (и это цель W0/W1).
    // Ревью 2026-09-24 (B-F3): считаем от конца РЕЧИ, а не от входа в listening (владелец, начавший
    // фразу на 9-й секунде, терял её хвост), и с потолком LISTEN_HOLD_CAP_MS — фон гейт вечно не держит.
    if (this.localWakeAvailable() && !this.holdOpen && !this.muted && this.gateOpen && state === "listening") {
      this.closer.arm(LISTEN_IDLE_CLOSE_MS, LISTEN_HOLD_CAP_MS);
    } else if (state !== "idle") this.closer.clear(); // thinking/speaking: ход в работе — таймер не нужен
  }

  /** B-F3: таймер тишины/потолка сработал — закрываем, только если хода нет и гейт держать некому. */
  private onCloserFire(kind: GateCloseKind): void {
    if (!this.gateOpen || this.holdOpen || this.muted || !this.localWakeAvailable()) return;
    // Хода нет = сервер в listening ИЛИ idle (push-to-talk при простое: кадров не было — сервер не проснулся).
    if (this.lastServerState === "thinking" || this.lastServerState === "speaking") return;
    this.closeGate(kind === "cap" ? "listen-cap-local-wake" : "listen-idle-local-wake");
  }

  /** Принудительно закрыть микрофон (честный mute, §0.6). */
  mute(): void {
    this.muted = true;
    this.holdOpen = false;
    this.preroll = [];
    this.playbackActive = false; // звук гасится вместе с mute → снимаем barge-окно
    this.resetBargeSustain(); // окно закрыто — счётчик устойчивости не должен пережить разрыв (ревью #close)
    this.closeGate("mute");
  }

  /**
   * §10 (ревью 2026-07-15): обнулить отсчёт устойчивости barge. Зовётся при ЗАКРЫТИИ окна перебивания —
   * иначе стейл `bargeVoicedSince`, набранный коротким голосом владельца, переживал бы разрыв окна и на
   * ПЕРВОМ же транзиенте после реоткрытия давал ложный barge (воскрешение бага «спайк рвёт длинную фразу»).
   */
  private resetBargeSustain(): void {
    this.bargeVoicedSince = 0;
    this.bargeBelowSince = 0;
  }

  /**
   * §10 renderer сообщает, ИДЁТ ЛИ СЕЙЧАС воспроизведение TTS. Нужно, чтобы перебивание работало и в
   * «хвосте»: сервер уходит из speaking по концу СИНТЕЗА, а плеер ещё доигрывает очередь фраз — раньше в
   * этом окне barge был выключен (serverSpeaking=false) и Джарвиса нельзя было заткнуть голосом.
   */
  setPlaybackActive(active: boolean): void {
    this.playbackActive = active;
    if (active) this.playbackActiveSince = this.now();
    // Окно перебивания только что закрылось (звук доиграл) → обнуляем отсчёт устойчивости, чтобы он не
    // пережил разрыв до следующей фразы и не выстрелил ложным barge на транзиенте при реоткрытии (ревью #close).
    if (!this.bargeWindowActive()) this.resetBargeSustain();
  }

  /** Активно ли окно перебивания: сервер говорит ЛИБО звук ещё реально играет (с бэкстопом от залипания). */
  private bargeWindowActive(): boolean {
    if (this.serverSpeaking) return true;
    return this.playbackActive && this.now() - this.playbackActiveSince < MAX_PLAYBACK_TAIL_MS;
  }

  // ── внутреннее ─────────────────────────────────────────────

  private streamFrame(pcm: Int16Array): void {
    const sig = this.vad.process(pcm);
    if (this.bargeWindowActive()) {
      // Пока Джарвис говорит ИЛИ звук ещё реально играет (хвост очереди) — любой VAD-сигнал трактуем
      // ТОЛЬКО как кандидат на перебивание (speech_start серверу не шлём — STT в speaking всё равно не
      // кормится; а в хвосте barge сам переведёт в listening, и дальше речь поймается обычным путём).
      this.maybeBargeIn(pcm, sig);
    } else {
      // Окно перебивания закрыто (в т.ч. tail-таймаут без явной мутации) → отсчёт устойчивости не копим/не
      // держим: иначе стейл пережил бы разрыв и выстрелил бы ложным barge при реоткрытии (ревью #close).
      this.resetBargeSustain();
      // §10 адаптивный barge: копим ФОН только вне окна речи Джарвиса (его TTS/эхо фон не задирают).
      this.ambientRms += AMBIENT_EMA_ALPHA * (rms(pcm) - this.ambientRms);
      if (sig === "speech_start") {
        this.speechOpen = true;
        this.deps.sendVad("speech_start");
        this.log.info("VAD: speech_start");
      } else if (sig === "speech_end") {
        this.speechOpen = false;
        this.deps.sendVad("speech_end");
        this.log.info("VAD: speech_end");
      }
    }
    // B-F3: идёт речь — дедлайн «тишины» сдвигается (потолок — нет). No-op, если таймер не взведён.
    if (this.vad.speaking) this.closer.touch();
    this.deps.sendFrame(pcm);
    this.framesSent += 1;
    // Диагностика: периодически подтверждаем, что кадры реально уходят на сервер.
    if (this.framesSent % 150 === 1) {
      this.log.info("аудио-кадры → сервер", {
        sent: this.framesSent,
        gateOpen: this.gateOpen,
        serverSpeaking: this.serverSpeaking,
      });
    }
  }

  /**
   * §10 barge-in: перебивание во время TTS. Чувствительнее обычного VAD (ниже порог, быстрее
   * онсет) — громкий TTS маскирует юзера. Эхо-окно отсекает первые мс (хвост собственного эха
   * сквозь AEC). Срабатывает ОДИН раз за сессию речи Джарвиса → мгновенный стоп плеера + сигнал.
   */
  private maybeBargeIn(pcm: Int16Array, sig: VadSignal): void {
    const level = rms(pcm);
    if (level > this.bargePeak) this.bargePeak = level; // диагностика: фиксируем пик ДО грейс-гарда
    // §10 живой пик периодически — чтобы по логу видеть РЕАЛЬНЫЙ уровень микрофона во время речи Джарвиса
    // (если пик 0 даже когда ты говоришь → AEC душит double-talk/колонки; если ~порог → подкрутить порог).
    // §10 адаптивный порог: фон (игра/музыка из колонок) задирает базу — barge требует голоса ПОВЕРХ фона,
    // иначе фоновый звук рвал каждую фразу через пару слов («озвучивает 2 слова», живой лог: 349–2049 при 250).
    const gate = Math.max(BARGE_THRESHOLD, this.ambientRms * BARGE_OVER_AMBIENT);
    this.bargeFrames += 1;
    if (this.bargeFrames % 25 === 0) {
      this.log.info("barge: уровень микрофона", { level: Math.round(level), peak: Math.round(this.bargePeak), gate: Math.round(gate), ambient: Math.round(this.ambientRms) });
    }
    if (this.lastBargeAt > 0 && this.now() - this.lastBargeAt < BARGE_REFRACTORY_MS) return; // рефрактер: не дребезжим (но не блокируем ПЕРВЫЙ barge)
    if (this.serverSpeaking && this.now() - this.speakingSince < BARGE_GRACE_MS) return; // эхо в начале речи
    // §10 barge ПО ВРЕМЕНИ (fix 2026-07-15): непрерывное превышение порога ≥BARGE_SUSTAIN_MS. Провал ниже
    // порога (пауза между словами эха/шума) СБРАСЫВАЕТ отсчёт — интермиттентный спайк речь не рвёт, а сплошное
    // «стоп/тихо» накопит устойчивость. Раньше 2 кадра (~20мс) рвали длинные фразы. Калибровка порога — выше.
    const now = this.now();
    if (level >= gate) {
      if (this.bargeVoicedSince === 0) this.bargeVoicedSince = now;
      this.bargeBelowSince = 0; // снова выше порога — «тишина» прервана
    } else if (this.bargeVoicedSince > 0) {
      // Ниже порога ВНУТРИ отсчёта: короткий провал (микро-пауза речи) терпим, сброс только на СТОЙКОЙ тишине.
      if (this.bargeBelowSince === 0) this.bargeBelowSince = now;
      if (now - this.bargeBelowSince > BARGE_GAP_TOLERANCE_MS) {
        this.bargeVoicedSince = 0;
        this.bargeBelowSince = 0;
      }
    }
    if (this.bargeVoicedSince > 0 && now - this.bargeVoicedSince >= BARGE_SUSTAIN_MS) {
      this.lastBargeAt = now;
      this.bargeVoicedSince = 0;
      this.bargeBelowSince = 0;
      this.playbackActive = false; // звук сейчас оборвём → снимаем barge-окно (renderer тоже пришлёт idle)
      this.deps.onBargeIn?.(); // мгновенно глушим плеер в renderer
      this.speechOpen = true; // B-F3: сервер на barge_in ставит userSpeaking=true — конец речи за нами
      this.deps.sendVad("barge_in"); // сервер отменяет синтез
      this.log.info("barge_in (устойчивая речь поверх TTS — стоп)", {
        level: Math.round(level),
        gate: Math.round(gate),
        ambient: Math.round(this.ambientRms),
        sustainMs: BARGE_SUSTAIN_MS,
      });
    }
  }

  private openGate(reason: string): void {
    this.gateOpen = true;
    this.wakeMiss.reset(); // отрезок, на котором гейт открылся, — попадание, а не промах
    this.log.info("гейт микрофона ОТКРЫТ", { reason });
    this.deps.onMicState?.(true);
  }

  private closeGate(reason = "close"): void {
    if (!this.gateOpen) return;
    this.gateOpen = false;
    this.closer.clear();
    // B-F3: закрылись посреди речи → сервер обязан узнать о её конце (иначе userSpeaking залипает).
    if (this.speechOpen) {
      this.speechOpen = false;
      this.deps.sendVad("speech_end");
      this.log.info("гейт закрыт посреди речи — серверу досылаю speech_end", { reason });
    }
    // Иначе VAD останется speaking, и speech_start новой реплики после реоткрытия серверу не уйдёт.
    if (this.vad.speaking) (this.vad as { reset?: () => void }).reset?.();
    this.wakeMiss.reset();
    this.preroll = [];
    (this.wakeword as { reset?: () => void }).reset?.(); // хвост прошлого хода не должен «будить» сам себя
    this.log.info("гейт микрофона ЗАКРЫТ", { reason, localWake: this.localWakeAvailable() });
    this.deps.onMicState?.(false);
  }
}
