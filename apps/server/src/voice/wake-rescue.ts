/**
 * Подстраховка слова «Джарвис» (28.09, решение владельца «облачная подстраховка»).
 *
 * Локальный детектор (sherpa KWS, английская модель на русском слове) пропускает ~каждую вторую попытку: 28.09 из 10
 * успешных пробуждений 5 потребовали повтора. Клиент шлёт громкий короткий фрагмент, на котором детектор промолчал
 * при ЗАКРЫТОМ гейте (audio.wake_rescue), а здесь его судят разовым облачным STT: есть обращение в ТЕКСТЕ — ход
 * принимается, как если бы «Джарвис» сработал (те же fuzzy-варианты, что у гейта wake); нет — фрагмент выбрасывается.
 *
 * Границы (privacy §0.6 сужен, но не снят): в облако уходит только сам фрагмент 1–4 с, только когда сервер в покое;
 * текст отвергнутого фрагмента не логируется и нигде не хранится; лимиты по частоте и в час защищают счёт Deepgram.
 * Чистая логика с внедрёнными зависимостями — пайплайн подаёт свои методы (voice/pipeline.ts `rescueWake`).
 */
import type { Logger } from "@jarvis/shared";
import { isWakeAddressedStrict } from "./wake-strict.js";

/** accepted — ход запущен по фрагменту; window — во фрагменте только «Джарвис»: окно адресации открыто, ход не запущен. */
export type RescueVerdict = "accepted" | "window" | "rejected" | "skipped";

/** Потолок размера фрагмента: клиент режет до ~4,5 с (≈144 КБ при 16 кГц mono s16le); больше — не наш клиент/не подстраховка. */
export const RESCUE_MAX_BYTES = 200_000;
/** Короче ~0,4 с слово не уместится (16 кГц × 2 байта). */
export const RESCUE_MIN_BYTES = 12_800;
const SAMPLE_RATE = 16_000;
/** Не чаще одного фрагмента за это время: серия хлопков/реплик ТВ не должна забивать очередь. */
export const RESCUE_MIN_GAP_MS = 1_500;
/** Потолок в час: страховка счёта, если рядом громко разговаривают или идёт фильм. */
export const RESCUE_MAX_PER_HOUR = 150;
/**
 * Антифон (ревью 28.09, B7): подряд много фрагментов без обращения — идёт голосовой чат/ТВ/разговор, а не попытки позвать
 * (настоящая попытка — 1 за минуты). Такой поток в облако не льём: пауза BACKOFF_MS. Реальные попытки в паузу спасает
 * обычный локальный «Джарвис» и кнопка микрофона, как до подстраховки.
 */
export const RESCUE_NOISE_REJECTS = 6;
export const RESCUE_NOISE_WINDOW_MS = 120_000;
export const RESCUE_BACKOFF_MS = 300_000;

export interface WakeRescueDeps {
  /** Разовое STT (ISttProvider.transcribeOnce). Нет ключа/сети — бросает. */
  transcribe: (pcm: ArrayBuffer, sampleRate: number) => Promise<string>;
  /** Пост-STT нормализатор лексики (латиница → кириллица), как у gateWake. */
  normalize?: (raw: string) => string;
  /** Конвейер в покое (idle): чужой ход не перебиваем, второй раз не будим. */
  isIdle: () => boolean;
  /** Принять текст (пайплайн): "turn" — ход запущен; "window" — только «Джарвис», окно адресации открыто; false — не принят. */
  accept: (text: string) => "turn" | "window" | false;
  /** Эпоха сброса (mute / speech_cancel / dispose): изменилась за время разбора — фрагмент устарел, ход не запускаем. */
  epoch?: () => number;
  now?: () => number;
  log: Logger;
}

export class WakeRescue {
  private lastAt = Number.NEGATIVE_INFINITY;
  private readonly stamps: number[] = [];
  private inflight = false;
  private capLogged = false;
  private rejects: number[] = [];
  private backoffUntil = 0;

  constructor(private readonly deps: WakeRescueDeps) {}

  private noteReject(at: number): void {
    this.rejects = this.rejects.filter((t) => at - t < RESCUE_NOISE_WINDOW_MS);
    this.rejects.push(at);
    if (this.rejects.length >= RESCUE_NOISE_REJECTS) {
      this.backoffUntil = at + RESCUE_BACKOFF_MS;
      this.rejects = [];
      this.deps.log.warn("wake-rescue: поток фрагментов без обращения (голосовой чат/ТВ?) — подстраховка молчит", { minutes: RESCUE_BACKOFF_MS / 60_000 });
    }
  }

  async judge(pcm: ArrayBuffer, sampleRate: number, meta: { ms?: number; peak?: number } = {}): Promise<RescueVerdict> {
    const now = this.deps.now ?? (() => Date.now());
    const skip = (why: string): RescueVerdict => {
      this.deps.log.debug("wake-rescue: пропуск", { why, ms: meta.ms });
      return "skipped";
    };
    if (sampleRate !== SAMPLE_RATE || pcm.byteLength < RESCUE_MIN_BYTES || pcm.byteLength > RESCUE_MAX_BYTES) return skip("формат/размер");
    if (!this.deps.isIdle()) return skip("ход уже идёт");
    if (this.inflight) return skip("предыдущий фрагмент ещё в разборе");
    const t0 = now();
    if (t0 < this.backoffUntil) return skip("фон: много фрагментов без обращения");
    if (t0 - this.lastAt < RESCUE_MIN_GAP_MS) return skip("слишком часто");
    while (this.stamps.length > 0 && t0 - this.stamps[0]! > 3_600_000) this.stamps.shift();
    if (this.stamps.length >= RESCUE_MAX_PER_HOUR) {
      if (!this.capLogged) this.deps.log.warn("wake-rescue: потолок в час исчерпан — подстраховка молчит до конца часа", { cap: RESCUE_MAX_PER_HOUR });
      this.capLogged = true;
      return skip("потолок в час");
    }
    this.capLogged = false;
    this.lastAt = t0;
    this.stamps.push(t0);
    this.inflight = true;
    const epoch0 = this.deps.epoch?.();
    try {
      let text = "";
      try {
        text = (await this.deps.transcribe(pcm, sampleRate)).trim();
      } catch (e) {
        this.deps.log.warn("wake-rescue: облачное распознавание не удалось — фрагмент отброшен", e instanceof Error ? e.message : String(e));
        return "skipped";
      }
      const took = now() - t0;
      // Строгое обращение — по СЫРОМУ тексту, ДО нормализатора лексики: тот пишет входной текст в лог при любой замене
      // (ревью B2: чужая речь с «Dota» попадала в файловый лог). Отвергнутый фрагмент нормализатору не показываем.
      if (!text || !isWakeAddressedStrict(text)) {
        this.noteReject(t0);
        // Текст отвергнутого фрагмента НЕ логируем: это может быть фон/чужая речь.
        this.deps.log.info("wake-rescue: обращения во фрагменте нет — выброшен", { ms: meta.ms, peak: meta.peak, chars: text.length, tookMs: took });
        return "rejected";
      }
      this.rejects = [];
      if (!this.deps.isIdle()) return skip("за время распознавания ход начался иначе");
      if (epoch0 !== undefined && this.deps.epoch?.() !== epoch0) return skip("микрофон выключили/сессия сброшена во время разбора");
      const normalized = (this.deps.normalize?.(text) ?? text).trim();
      const how = this.deps.accept(normalized);
      if (!how) return skip("конвейер не принял");
      this.deps.log.info(how === "turn" ? "wake-rescue: обращение найдено облачным STT — ход принят" : "wake-rescue: только «Джарвис» — окно адресации открыто", { ms: meta.ms, peak: meta.peak, tookMs: took });
      return how === "turn" ? "accepted" : "window";
    } finally {
      this.inflight = false;
    }
  }
}
