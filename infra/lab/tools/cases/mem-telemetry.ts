import { mkdirSync, writeFileSync } from "node:fs";
/** Телеметрия в каталог данных кейса (metrics.jsonl) — сырьё self_weaknesses. Возвращает sessionId для геттера. */
export function seedTelemetry(events: object[]): string {
  const dir = `${process.env.JARVIS_DATA_DIR}/logs`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/metrics.jsonl`, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return "lab-session";
}
export const DAY = 86_400_000;
export const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
export const degradation = (kind: string, query: string, at = 1000): object => ({ type: "degradation", kind, query, ts: ago(at) });
export const taskEvent = (ok: boolean, failKind?: string, at = 2000): object => ({ ok, rounds: failKind ? 0 : 3, usage: { outputTokens: failKind ? 0 : 100 }, ts: ago(at), ...(failKind ? { failKind } : {}) });
