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
const BARGE_ONSET_FRAMES = 2;
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

export class AudioCoordinator {
  private readonly wakeword: IWakeWord;
  private readonly vad: IVad;
  private readonly log: Logger;
  private readonly now: () => number;
  private gateOpen = false;
  private serverSpeaking = false;
  /** §10 идёт ли СЕЙЧАС реальное воспроизведение TTS в renderer (хвост очереди после конца синтеза). */
  private playbackActive = false;
  private playbackActiveSince = 0;
  /** Когда сервер начал говорить (для anti-echo grace §10); 0 — не говорит. */
  private speakingSince = 0;
  /** Счётчик громких кадров для чувствительного barge-in + время последнего barge (рефрактер). */
  private bargeVoiced = 0;
  private lastBargeAt = 0;
  /** §10 скользящий ФОН микрофона (EMA по кадрам обычной прослушки) — база адаптивного порога barge. */
  private ambientRms = 0;
  private bargeFrames = 0; // диагностика: кадры в barge-окне (для периодического лога пика)
  /** Пиковый rms микрофона за текущую сессию речи Джарвиса (диагностика порога barge-in §10). */
  private bargePeak = 0;
  private framesSent = 0; // диагностика потока кадров

  constructor(private readonly deps: AudioCoordinatorDeps) {
    this.wakeword = deps.wakeword ?? new MockWakeWord();
    this.vad = deps.vad ?? new EnergyVad();
    this.log = deps.log ?? createLogger("audio");
    this.now = deps.now ?? (() => Date.now());
  }

  get streaming(): boolean {
    return this.gateOpen;
  }

  /** Push-to-talk / явная активация (когда реальный wake word недоступен, §18). */
  activate(): void {
    if (!this.gateOpen) this.openGate("manual");
  }

  /** Принять кадр PCM16 из renderer. */
  ingest(pcm: Int16Array): void {
    if (!this.gateOpen) {
      // Гейт закрыт: аудио на сервер НЕ уходит (§0.6). Только wake word локально.
      if (this.wakeword.ready && this.wakeword.process(pcm)) {
        this.openGate("wakeword");
        this.streamFrame(pcm);
      }
      return;
    }
    this.streamFrame(pcm);
  }

  /** Сервер сообщил своё состояние (client.state): отслеживаем speaking. */
  setServerState(state: ClientState): void {
    const wasSpeaking = this.serverSpeaking;
    this.serverSpeaking = state === "speaking";
    // Засекаем момент старта речи для anti-echo grace (§10) — только на фронте idle→speaking.
    // И сбрасываем barge-детектор: перебить можно ОДИН раз за сессию речи Джарвиса.
    if (this.serverSpeaking && !wasSpeaking) {
      this.speakingSince = this.now();
      this.bargeVoiced = 0;
      this.lastBargeAt = 0;
      this.bargePeak = 0;
      this.bargeFrames = 0;
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
    // §3 ambient: НЕ закрываем гейт на idle. Раньше после первой реплики сервер
    // уходил в idle → гейт закрывался НАВСЕГДА (wake word — заглушка, открыть
    // некому) → Джарвис «глох» после первого ответа. Слушаем постоянно с момента
    // активации; приватность — только через явный mute() (§0.6).
  }

  /** Принудительно закрыть микрофон (честный mute, §0.6). */
  mute(): void {
    this.playbackActive = false; // звук гасится вместе с mute → снимаем barge-окно
    this.closeGate();
  }

  /**
   * §10 renderer сообщает, ИДЁТ ЛИ СЕЙЧАС воспроизведение TTS. Нужно, чтобы перебивание работало и в
   * «хвосте»: сервер уходит из speaking по концу СИНТЕЗА, а плеер ещё доигрывает очередь фраз — раньше в
   * этом окне barge был выключен (serverSpeaking=false) и Джарвиса нельзя было заткнуть голосом.
   */
  setPlaybackActive(active: boolean): void {
    this.playbackActive = active;
    if (active) this.playbackActiveSince = this.now();
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
      // §10 адаптивный barge: копим ФОН только вне окна речи Джарвиса (его TTS/эхо фон не задирают).
      this.ambientRms += AMBIENT_EMA_ALPHA * (rms(pcm) - this.ambientRms);
      if (sig === "speech_start") {
        this.deps.sendVad("speech_start");
        this.log.info("VAD: speech_start");
      } else if (sig === "speech_end") {
        this.deps.sendVad("speech_end");
        this.log.info("VAD: speech_end");
      }
    }
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
    this.bargeVoiced = level >= gate ? this.bargeVoiced + 1 : 0;
    // barge-in ТОЛЬКО по калиброванному порогу + онсет-дебаунсу. Раньше `|| sig==="speech_start"`
    // обходил калибровку → один VAD-онсет (эхо/шум) рвал TTS. Убрано (см. ревью).
    if (this.bargeVoiced >= BARGE_ONSET_FRAMES) {
      this.lastBargeAt = this.now();
      this.bargeVoiced = 0;
      this.playbackActive = false; // звук сейчас оборвём → снимаем barge-окно (renderer тоже пришлёт idle)
      this.deps.onBargeIn?.(); // мгновенно глушим плеер в renderer
      this.deps.sendVad("barge_in"); // сервер отменяет синтез
      this.log.info("barge_in (речь поверх TTS — стоп)", { level: Math.round(level), gate: Math.round(gate), ambient: Math.round(this.ambientRms) });
    }
  }

  private openGate(reason: string): void {
    this.gateOpen = true;
    this.log.info("гейт микрофона ОТКРЫТ", { reason });
    this.deps.onMicState?.(true);
  }

  private closeGate(): void {
    if (!this.gateOpen) return;
    this.gateOpen = false;
    this.log.info("гейт микрофона ЗАКРЫТ");
    this.deps.onMicState?.(false);
  }
}
