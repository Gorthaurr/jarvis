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
import { isWakeAddressed } from "./wake.js";

export type RescueVerdict = "accepted" | "rejected" | "skipped";

/** Потолок размера фрагмента: клиент режет до ~4,5 с (≈144 КБ при 16 кГц mono s16le); больше — не наш клиент/не подстраховка. */
export const RESCUE_MAX_BYTES = 200_000;
/** Короче ~0,4 с слово не уместится (16 кГц × 2 байта). */
export const RESCUE_MIN_BYTES = 12_800;
const SAMPLE_RATE = 16_000;
/** Не чаще одного фрагмента за это время: серия хлопков/реплик ТВ не должна забивать очередь. */
export const RESCUE_MIN_GAP_MS = 1_500;
/** Потолок в час: страховка счёта, если рядом громко разговаривают или идёт фильм. */
export const RESCUE_MAX_PER_HOUR = 150;

export interface WakeRescueDeps {
  /** Разовое STT (ISttProvider.transcribeOnce). Нет ключа/сети — бросает. */
  transcribe: (pcm: ArrayBuffer, sampleRate: number) => Promise<string>;
  /** Пост-STT нормализатор лексики (латиница → кириллица), как у gateWake. */
  normalize?: (raw: string) => string;
  /** Конвейер в покое (idle): чужой ход не перебиваем, второй раз не будим. */
  isIdle: () => boolean;
  /** Принять текст как адресованный ход (пайплайн: gateWake + wake + transcript_final). false — не принят. */
  accept: (text: string) => boolean;
  now?: () => number;
  log: Logger;
}

export class WakeRescue {
  private lastAt = Number.NEGATIVE_INFINITY;
  private readonly stamps: number[] = [];
  private inflight = false;
  private capLogged = false;

  constructor(private readonly deps: WakeRescueDeps) {}

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
    try {
      let text = "";
      try {
        text = (await this.deps.transcribe(pcm, sampleRate)).trim();
      } catch (e) {
        this.deps.log.warn("wake-rescue: облачное распознавание не удалось — фрагмент отброшен", e instanceof Error ? e.message : String(e));
        return "skipped";
      }
      const normalized = (this.deps.normalize?.(text) ?? text).trim();
      const took = now() - t0;
      if (!normalized || !isWakeAddressed(normalized)) {
        // Текст отвергнутого фрагмента НЕ логируем: это может быть фон/чужая речь.
        this.deps.log.info("wake-rescue: обращения во фрагменте нет — выброшен", { ms: meta.ms, peak: meta.peak, chars: normalized.length, tookMs: took });
        return "rejected";
      }
      if (!this.deps.isIdle()) return skip("за время распознавания ход начался иначе");
      if (!this.deps.accept(normalized)) return skip("конвейер не принял");
      this.deps.log.info("wake-rescue: обращение найдено облачным STT — ход принят", { ms: meta.ms, peak: meta.peak, tookMs: took });
      return "accepted";
    } finally {
      this.inflight = false;
    }
  }
}
