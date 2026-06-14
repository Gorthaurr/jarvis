/**
 * AudioWorkletProcessor захвата (§3, §10).
 *
 * Берёт вход с микрофона (Float32 @ sampleRate контекста, обычно 48к), грубо
 * ресемплит до 16 кГц mono, упаковывает в Int16 PCM и постит кадрами ~20 мс
 * (320 сэмплов @16к). Кадр уходит в main через postMessage (transfer ArrayBuffer).
 *
 * Это отдельный модуль (грузится audioWorklet.addModule), НЕ бандлится esbuild'ом.
 */
const TARGET_RATE = 16000;
const FRAME_SAMPLES = 320; // 20 мс при 16 кГц

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._acc = [];
    this._accLen = 0;
    // Шаг децимации от частоты контекста к 16к.
    this._ratio = sampleRate / TARGET_RATE;
    this._pos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;

    // Простой ресемпл «ближайший сэмпл» (для VAD/STT достаточно; качество — позже).
    for (let i = 0; i < ch.length; i += 1) {
      this._pos += 1;
      if (this._pos >= this._ratio) {
        this._pos -= this._ratio;
        const s = Math.max(-1, Math.min(1, ch[i]));
        this._acc.push(s < 0 ? s * 0x8000 : s * 0x7fff);
        this._accLen += 1;
        if (this._accLen >= FRAME_SAMPLES) {
          const pcm = new Int16Array(this._acc);
          this._acc = [];
          this._accLen = 0;
          this.port.postMessage(pcm.buffer, [pcm.buffer]);
        }
      }
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
