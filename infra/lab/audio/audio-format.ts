/**
 * Формат и длительность озвучки, пришедшей в speak.chunk: pcm16 (Yandex v3, `format:"pcm16"`), RIFF WAV (earcon/филлер, без
 * `format`) и mp3 (Yandex v1/ElevenLabs — один mp3 на фразу). Длительность нужна фейковому плееру: сервер по audio.playback
 * решает, когда отдавать следующую реплику, — без честного «играет N секунд» очередь речи и метрики врут.
 * mp3 считается обходом MPEG-заголовков кадров (точно для CBR и VBR); не разобрали — оценка по байтам при 128 кбит/с,
 * и это помечено `estimated`.
 */
export type AudioKind = "mp3" | "wav" | "pcm16" | "bin";

export function sniff(b: Buffer, format?: string): AudioKind {
  if (format === "pcm16") return "pcm16";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE") return "wav";
  if (b.length >= 3 && b.toString("ascii", 0, 3) === "ID3") return "mp3";
  if (b.length >= 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) return "mp3";
  return "bin";
}

export const EXT: Record<AudioKind, string> = { mp3: "mp3", wav: "wav", pcm16: "wav", bin: "bin" };
export const MIME: Record<AudioKind, string> = { mp3: "audio/mpeg", wav: "audio/wav", pcm16: "audio/wav", bin: "application/octet-stream" };

const BR_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Длительность mp3, мс; estimated=true — заголовки не разобрались (оценка по размеру). */
export function mp3DurationMs(b: Buffer): { ms: number; estimated: boolean } {
  let p = 0;
  if (b.toString("ascii", 0, 3) === "ID3" && b.length >= 10) p = 10 + (((b[6] ?? 0) & 0x7f) << 21) + (((b[7] ?? 0) & 0x7f) << 14) + (((b[8] ?? 0) & 0x7f) << 7) + ((b[9] ?? 0) & 0x7f);
  let samples = 0;
  let rate = 0;
  let frames = 0;
  while (p + 4 <= b.length) {
    const h = b.readUInt32BE(p);
    const ver = (h >>> 19) & 3; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layer = (h >>> 17) & 3; // 1=Layer III
    const br = (h >>> 12) & 15;
    const sri = (h >>> 10) & 3;
    const pad = (h >>> 9) & 1;
    const rates = SR[ver];
    if (h >>> 21 !== 0x7ff || layer !== 1 || !rates || br === 0 || br === 15 || sri === 3) {
      p += 1; // не заголовок (мусор/тег) — сдвигаемся; но после первого кадра рассинхрон = конец разбора
      if (frames > 0) break;
      continue;
    }
    rate = rates[sri] ?? 0;
    const kbps = (ver === 3 ? BR_V1_L3 : BR_V2_L3)[br] ?? 0;
    const len = Math.floor(((ver === 3 ? 144 : 72) * kbps * 1000) / rate) + pad;
    samples += ver === 3 ? 1152 : 576;
    frames += 1;
    p += len;
  }
  if (frames === 0 || rate === 0) return { ms: Math.round(((b.length * 8) / 128_000) * 1000), estimated: true };
  return { ms: Math.round((samples / rate) * 1000), estimated: false };
}

/** Длительность WAV из заголовка (data / byteRate), мс. */
export function wavDurationMs(b: Buffer): number {
  for (let p = 12, byteRate = 0; p + 8 <= b.length; ) {
    const id = b.toString("ascii", p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === "fmt ") byteRate = b.readUInt32LE(p + 16);
    if (id === "data") return byteRate > 0 ? Math.round((Math.min(size, b.length - p - 8) / byteRate) * 1000) : 0;
    p += 8 + size + (size % 2);
  }
  return 0;
}

export const pcm16DurationMs = (bytes: number, rate: number): number => Math.round((bytes / 2 / rate) * 1000);
