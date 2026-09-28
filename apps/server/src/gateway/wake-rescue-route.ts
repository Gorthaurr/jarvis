/**
 * Маршрут `audio.wake_rescue` (подстраховка «Джарвис», 28.09): фрагмент речи, на котором локальный детектор клиента
 * промолчал. Судит VoicePipeline.rescueWake; клиенту уходит вердикт только при принятии (accepted / bare).
 */
import type { Envelope, WakeRescue } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import type { SessionContext } from "./router-ws.js";

const log = createLogger("wake-rescue");

/** Фрагмент старше этого (мс) отбрасывается: пришёл из буфера рукопожатия/очереди, а не «сейчас». */
export const RESCUE_MAX_AGE_MS = 6_000;

function pcmOf(b64: string): ArrayBuffer {
  const buf = Buffer.from(b64, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export function routeWakeRescue(ctx: SessionContext, env: Envelope): void {
  const r = env.payload as WakeRescue;
  // Запись голосового отпечатка идёт своим потоком — не мешаем.
  if (ctx.enroll || typeof r?.pcm !== "string") return;
  if (Number.isFinite(env.ts) && Date.now() - env.ts > RESCUE_MAX_AGE_MS) return;
  void ctx.voice
    .rescueWake(pcmOf(r.pcm), Number(r.sampleRate), { ms: Number(r.ms) || undefined, peak: Number(r.peak) || undefined })
    .then((v) => {
      if (v === "accepted" || v === "window") ctx.session.send("wake.rescue.result", { accepted: true, ...(v === "window" ? { bare: true } : {}) });
    })
    .catch((e) => log.warn("сбой обработки фрагмента", e instanceof Error ? e.message : String(e)));
}
