/**
 * Presence-роутинг уведомлений (§9, §20).
 *
 * Уведомление летит на устройство, где пользователь сейчас активен (last_seen_at
 * в devices, §13). Десктоп активен → голос; иначе активен mobile → пуш (FCM).
 * Просроченный оффлайн-десктоп → отчёт о длинной задаче уходит пушем (§20).
 */

export type DeviceKind = "desktop" | "mobile";

export interface DeviceInfo {
  kind: DeviceKind;
  /** unix ms последней активности (presence). */
  lastSeenAt: number;
  /** Пуш-токен (FCM) — нужен для доставки на mobile. */
  pushToken?: string;
}

/** Окно «активности» устройства: позже него считаем неактивным. */
export const PRESENCE_ACTIVE_MS = 5 * 60_000;

export type RouteTarget = "desktop_voice" | "mobile_push" | "none";

export interface RouteDecision {
  target: RouteTarget;
  device?: DeviceInfo;
  reason: string;
}

/**
 * Куда доставить уведомление (§9). Десктоп активен → голос; иначе свежий mobile с
 * токеном → пуш; иначе некуда (положим в лог/доставим позже).
 */
export function routeNotification(devices: readonly DeviceInfo[], now: number): RouteDecision {
  const active = (d: DeviceInfo): boolean => now - d.lastSeenAt <= PRESENCE_ACTIVE_MS;

  const desktop = devices.find((d) => d.kind === "desktop" && active(d));
  if (desktop) return { target: "desktop_voice", device: desktop, reason: "десктоп активен" };

  // Самый свежий mobile с пуш-токеном.
  const mobiles = devices
    .filter((d) => d.kind === "mobile" && d.pushToken)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  if (mobiles[0]) return { target: "mobile_push", device: mobiles[0], reason: "доставка пушем (десктоп неактивен)" };

  return { target: "none", reason: "нет доступных устройств" };
}

/** Ушёл ли пользователь от десктопа (для отчёта пушем о завершении задачи, §20). */
export function userAwayFromDesktop(devices: readonly DeviceInfo[], now: number): boolean {
  const desktop = devices.find((d) => d.kind === "desktop");
  return !desktop || now - desktop.lastSeenAt > PRESENCE_ACTIVE_MS;
}
