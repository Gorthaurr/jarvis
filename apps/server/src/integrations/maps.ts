/**
 * Карты / ETA (§9, §12) — реализация IEtaProvider поверх OSRM/Yandex — стаб.
 *
 * Питает умное напоминание (scheduler.computeTriggerTs). Без OSRM_URL/ключа
 * Yandex возвращает фиксированную оценку (как StubEtaProvider), чтобы расчёт
 * времени триггера всё равно работал в dev-срезе.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import type { IEtaProvider } from "../proactive/scheduler.js";

const log: Logger = createLogger("maps");

export interface MapsConfig {
  /** "osrm" | "yandex". */
  provider: string;
  osrmUrl: string | undefined;
  yandexApiKey: string | undefined;
}

/** Геокоординаты для ETA (когда есть точные точки). */
export interface LatLng {
  lat: number;
  lng: number;
}

export class MapsEtaProvider implements IEtaProvider {
  readonly live: boolean;
  constructor(private readonly cfg: MapsConfig) {
    this.live =
      (cfg.provider === "osrm" && Boolean(cfg.osrmUrl)) ||
      (cfg.provider === "yandex" && Boolean(cfg.yandexApiKey));
    if (!this.live) log.warn("maps не сконфигурирован — ETA в стаб-режиме (20 мин)");
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async estimateEtaMs(_origin: string, _destination: string): Promise<number | null> {
    if (!this.live) return 20 * 60_000; // дефолтная оценка, чтобы scheduler работал.
    // TODO(M5/§12): реальный маршрут (OSRM /route или Yandex Distance Matrix).
    void this.cfg;
    return 20 * 60_000;
  }
}
