/**
 * Известные флейки (ДАННЫЕ). Совпадение — подстрока ключа «файл > имя теста». Известный флейк, проявившийся в скане,
 * не валит прогон, но всегда виден в отчёте; НОВЫЙ нестабильный тест — валит. Убирай запись, когда тест починен.
 */
export interface KnownFlake { match: string; reason: string }

export const KNOWN_FLAKES: KnownFlake[] = [
  {
    match: "jarvis-browser-pin.chromium.test.ts",
    reason: "ходит на живой example.com + top-level await DNS (карта test-infra-existing, дефект high): зависит от сети/VPN",
  },
];

export const knownFlakeOf = (key: string, known: KnownFlake[] = KNOWN_FLAKES): KnownFlake | undefined =>
  known.find((k) => key.includes(k.match));
