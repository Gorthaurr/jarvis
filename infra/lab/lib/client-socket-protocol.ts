import type { Envelope } from "@jarvis/protocol";
import { WebSocket, type WsLike } from "./deps.js";
import type { EventRecorder } from "./recorder.js";
export interface SocketOptions {
  url: string;
  token: string;
  clientVersion: string;
  rec: EventRecorder;
  onFrame(env: Envelope): void;
  connectTimeoutMs?: number;
  /** Переподключаться с resumeSessionId после неожиданного обрыва (по умолчанию да). */
  reconnect?: boolean;
  /** Оставлять base64-аудио в speak.chunk журнала (аудио-стенду нужны байты озвучки; по умолчанию режем — мегабайты). */
  keepAudio?: boolean;
}

/** Кадры с аудио в журнал кладём без base64 (мегабайты), с размером в audioBytes. */
export function redact(type: string, payload: unknown): unknown {
  if (type !== "speak.chunk" || !payload || typeof payload !== "object") return payload;
  const { audio, ...rest } = payload as Record<string, unknown>;
  return { ...rest, audioBytes: typeof audio === "string" ? Buffer.byteLength(audio, "base64") : 0 };
}

export async function closeSocket(ws: WsLike | undefined): Promise<void> {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      ws.terminate();
      resolve();
    }, 2_000);
    ws.on("close", () => {
      clearTimeout(t);
      resolve();
    });
    ws.close(1000, "lab done");
  });
}
