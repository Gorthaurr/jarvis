/**
 * Аудио в renderer (§3, §10): захват и воспроизведение живут ЗДЕСЬ, потому что
 * WebRTC AEC работает только внутри Chromium-пайплайна и режет собственный TTS —
 * иначе barge-in слышит сам себя. Микрофон горячий во время воспроизведения.
 *
 * Захват: getUserMedia(echoCancellation) → AudioWorklet (capture-processor) →
 * Int16 PCM кадры → main (jarvis.pushPcm). Воспроизведение: speak.chunk (base64) →
 * аккумуляция → decodeAudioData → WebAudio; barge-in мгновенно глушит источник.
 *
 * audio.frame по WS — dev-путь (§5); в проде PCM/воспроизведение идут по WebRTC (LiveKit).
 */

/** Захват микрофона → PCM16 кадры. */
export class AudioCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;

  constructor(private readonly onFrame: (pcm: ArrayBuffer) => void) {}

  async start(): Promise<void> {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    await this.ctx.audioWorklet.addModule("./audio-worklet.js");
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "capture-processor");
    this.node.port.onmessage = (ev: MessageEvent) => {
      this.onFrame(ev.data as ArrayBuffer);
    };
    // Держим граф живым через нулевой gain (без слышимого эха).
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    source.connect(this.node);
    this.node.connect(sink);
    sink.connect(this.ctx.destination);
  }

  async stop(): Promise<void> {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.node?.port.close();
    this.node = null;
    await this.ctx?.close();
    this.ctx = null;
  }
}

/** Воспроизведение TTS: аккумулирует чанки и проигрывает; barge-in глушит мгновенно. */
export class AudioPlayback {
  private ctx: AudioContext | null = null;
  private parts: Uint8Array[] = [];
  private source: AudioBufferSourceNode | null = null;

  private ensureCtx(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  /** Принять чанк (audio — base64). На последнем — декодировать и проиграть. */
  enqueue(chunk: { audio: string; seq: number; last: boolean }): void {
    if (chunk.audio) this.parts.push(base64ToBytes(chunk.audio));
    if (chunk.last) void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.parts.length === 0) return;
    const total = this.parts.reduce((n, p) => n + p.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const p of this.parts) {
      merged.set(p, off);
      off += p.byteLength;
    }
    this.parts = [];
    try {
      const ctx = this.ensureCtx();
      // Chromium может держать контекст suspended — будим явно, иначе тишина.
      if (ctx.state === "suspended") await ctx.resume();
      const buf = await ctx.decodeAudioData(merged.buffer.slice(0));
      this.stop(); // прервать предыдущий, если играл
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
      this.source = src;
    } catch {
      // dev: формат может не декодироваться (частичный поток) — игнор.
    }
  }

  /** Barge-in (§10): мгновенно заглушить воспроизведение. */
  stop(): void {
    this.parts = [];
    try {
      this.source?.stop();
    } catch {
      /* уже остановлен */
    }
    this.source = null;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
