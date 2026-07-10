/**
 * Протокол «speaker-сайдкара» (§3): верификатор диктора (sherpa-onnx) крутится в ОТДЕЛЬНОМ
 * Node-процессе, потому что его нативный onnxruntime КОНФЛИКТУЕТ с onnxruntime-node эмбеддера e5
 * в одном процессе на Windows (оба тянут onnxruntime.dll → второй биндинг падает). Изоляция в
 * дочерний процесс разводит их: e5 в главном, sherpa в сайдкаре → owner-gate жив ВМЕСТЕ с e5.
 *
 * Транспорт — newline-delimited JSON по stdio (как MCP/C#-сайдкар). PCM/байты профиля — base64.
 * Главный процесс шлёт запросы (identify/enroll.*), сайдкар отвечает; парные по числовому `id`.
 */
import type { SpeakerMatch } from "./verifier.js";

/** Профиль голоса «на проводе» (data — base64 байт центроида). */
export interface ProfileWire {
  name: string;
  data: string; // base64
  createdAt: number;
  dim?: number;
  modelId?: string;
}

/** Запрос главный→сайдкар. */
export type HostRequest =
  | { t: "identify"; id: number; pcm: string; profiles: ProfileWire[] }
  | { t: "enroll.start"; sess: number }
  | { t: "enroll.feed"; id: number; sess: number; pcm: string }
  | { t: "enroll.finish"; id: number; sess: number }
  | { t: "enroll.cancel"; sess: number };

/** Ответ сайдкар→главный. */
export type HostResponse =
  | {
      t: "hello";
      ready: boolean;
      dim: number;
      modelId: string;
      threshold: number;
      acceptThreshold: number;
      rejectThreshold: number;
      enrollSeconds: number;
    }
  | { t: "identify.res"; id: number; match: SpeakerMatch | null }
  | { t: "enroll.feed.res"; id: number; pct: number }
  | { t: "enroll.finish.res"; id: number; data: string | null };

// ── base64-кодеки (копируют в выровненный буфер — Int16Array требует чётный byteOffset) ──

export function pcmToB64(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
}
export function b64ToPcm(b64: string): Int16Array {
  const u8 = Uint8Array.from(Buffer.from(b64, "base64")); // свежий буфер @offset 0 → выровнен
  return new Int16Array(u8.buffer, 0, u8.byteLength >> 1);
}
export function bytesToB64(u: Uint8Array): string {
  return Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString("base64");
}
export function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

/**
 * Парсер строк stdio в кадры протокола: накапливает чанки, режет по '\n', отдаёт КАЖДУЮ строку
 * как распарсенный JSON-объект с полем `t` (прочее — шум нативного sherpa/логов — молча игнор).
 */
export function createLineParser<T extends { t: string }>(onFrame: (frame: T) => void): (chunk: Buffer | string) => void {
  let buf = "";
  return (chunk) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as T;
        if (obj && typeof obj.t === "string") onFrame(obj);
      } catch {
        /* не-JSON строка (нативный stdout sherpa / лог) — игнорируем */
      }
    }
  };
}
