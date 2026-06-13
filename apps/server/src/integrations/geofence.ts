/**
 * Геофенс (§9) — интерфейс + стаб.
 *
 * Контекстные триггеры по входу/выходу из зоны (дом/работа). Источник позиции —
 * мобильный клиент (§12). Без данных позиции — no-op.
 */
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("geofence");

export interface GeoZone {
  id: string;
  lat: number;
  lng: number;
  /** Радиус зоны, м. */
  radiusM: number;
}

export interface GeoPosition {
  lat: number;
  lng: number;
  ts: number;
}

export type GeoEventKind = "enter" | "exit";

export interface GeoEvent {
  zoneId: string;
  kind: GeoEventKind;
  ts: number;
}

export interface IGeofenceProvider {
  /** Зарегистрировать зону наблюдения. */
  addZone(zone: GeoZone): void;
  /**
   * Сопоставить новую позицию с зонами; вернуть произошедшие события enter/exit.
   * Реальна базовая геометрия (haversine), состояние — в памяти.
   */
  evaluate(pos: GeoPosition): GeoEvent[];
}

/** Стаб с реальной геометрией зон (дешёвая часть реализована). */
export class GeofenceProvider implements IGeofenceProvider {
  private readonly zones = new Map<string, GeoZone>();
  /** В какой зоне сейчас находимся (для детекта enter/exit). */
  private readonly inside = new Set<string>();

  constructor() {
    log.debug("geofence провайдер инициализирован (in-memory)");
  }

  addZone(zone: GeoZone): void {
    this.zones.set(zone.id, zone);
  }

  evaluate(pos: GeoPosition): GeoEvent[] {
    const events: GeoEvent[] = [];
    for (const zone of this.zones.values()) {
      const within = haversineM(pos.lat, pos.lng, zone.lat, zone.lng) <= zone.radiusM;
      const was = this.inside.has(zone.id);
      if (within && !was) {
        this.inside.add(zone.id);
        events.push({ zoneId: zone.id, kind: "enter", ts: pos.ts });
      } else if (!within && was) {
        this.inside.delete(zone.id);
        events.push({ zoneId: zone.id, kind: "exit", ts: pos.ts });
      }
    }
    return events;
  }
}

/** Расстояние между точками по сфере, метры. */
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
