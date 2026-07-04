import { describe, expect, it } from "vitest";
import { SherpaSpeakerVerifier, type SherpaExtractor } from "./sherpa-verifier.js";
import type { VoiceProfile } from "./verifier.js";

const SR = 16_000;

/**
 * Фейковый экстрактор: эмбеддинг = детерминированный вектор по среднему |сэмпла|. Нативной
 * sherpa-onnx-модели/библиотеки в тесте нет — инжектим фейк прямо в класс (для этого он экспортится).
 */
function fakeExtractor(dim = 4): SherpaExtractor {
  const bufs = new WeakMap<object, number[]>();
  return {
    dim,
    createStream() {
      const buf: number[] = [];
      const stream = {
        acceptWaveform(o: { samples: Float32Array; sampleRate: number }) {
          for (const s of o.samples) buf.push(s);
        },
        inputFinished() {},
      };
      bufs.set(stream, buf);
      return stream;
    },
    isReady(s) {
      return (bufs.get(s)?.length ?? 0) >= 1600; // ~0.1с
    },
    compute(s) {
      const buf = bufs.get(s) ?? [];
      let sum = 0;
      for (const x of buf) sum += Math.abs(x);
      const mean = sum / Math.max(1, buf.length);
      return new Float32Array([mean, 1, 0.5, 0.25]);
    },
  };
}

/** Кадр PCM16 заданного пика (amp в [0..1]) длиной samples. */
function frame(amp: number, samples: number): Int16Array {
  return new Int16Array(samples).fill(Math.round(amp * 32_767));
}

/** Записать профиль через реальный enroll-поток (речь). */
async function makeProfile(v: SherpaSpeakerVerifier, amp = 0.3): Promise<VoiceProfile> {
  const s = v.enroll();
  for (let i = 0; i < 15; i += 1) await s.feed(frame(amp, SR)); // 15с речи (> минимума)
  const data = await s.finish();
  if (!data) throw new Error("enroll в setup не дал байт");
  return { name: "Антон", data, createdAt: 0 };
}

describe("SherpaSpeakerVerifier — качество отпечатка (§3)", () => {
  it("enrollment на ТИШИНЕ не наполняет шкалу и не сохраняется (фикс мусорного эталона)", async () => {
    const v = new SherpaSpeakerVerifier(fakeExtractor());
    const s = v.enroll();
    let pct = 0;
    for (let i = 0; i < 30; i += 1) pct = await s.feed(frame(0.01, SR)); // 30с почти-тишины
    expect(pct).toBe(0);
    expect(await s.finish()).toBeNull(); // мусор НЕ сохраняем
  });

  it("enrollment на РЕЧИ наполняет шкалу до 1 и отдаёт байты профиля", async () => {
    const v = new SherpaSpeakerVerifier(fakeExtractor());
    const s = v.enroll();
    let pct = 0;
    for (let i = 0; i < 15; i += 1) pct = await s.feed(frame(0.3, SR)); // 15с речи (> enrollSeconds=12)
    expect(pct).toBe(1);
    const data = await s.finish();
    expect(data).not.toBeNull();
    expect(data!.byteLength).toBeGreaterThan(0);
  });

  it("enrollment с недобором речи (< минимума) → честный отказ (null)", async () => {
    const v = new SherpaSpeakerVerifier(fakeExtractor());
    const s = v.enroll();
    for (let i = 0; i < 3; i += 1) await s.feed(frame(0.3, SR)); // только 3с речи (< 6)
    expect(await s.finish()).toBeNull();
  });

  it("тишина между речью не ломает прогресс (считается только речь)", async () => {
    const v = new SherpaSpeakerVerifier(fakeExtractor());
    const s = v.enroll();
    await s.feed(frame(0.3, SR * 7)); // 7с речи
    await s.feed(frame(0.01, SR * 20)); // 20с тишины — не считается
    const pct = await s.feed(frame(0.3, SR * 7)); // ещё 7с речи → суммарно 14с > 12
    expect(pct).toBe(1);
    expect(await s.finish()).not.toBeNull();
  });

  it("identify на ТИХОМ ходе → null (гейт пускает, не запирает владельца)", async () => {
    const v = new SherpaSpeakerVerifier(fakeExtractor());
    const profiles = [await makeProfile(v)];
    expect(await v.identify(frame(0.02, SR), profiles)).toBeNull();
  });

  it("identify на КОРОТКОМ ходе → null (нельзя надёжно опознать)", async () => {
    const v = new SherpaSpeakerVerifier(fakeExtractor());
    const profiles = [await makeProfile(v)];
    expect(await v.identify(frame(0.3, Math.floor(SR * 0.2)), profiles)).toBeNull();
  });

  it("identify без профилей → null", async () => {
    const v = new SherpaSpeakerVerifier(fakeExtractor());
    expect(await v.identify(frame(0.3, SR), [])).toBeNull();
  });

  it("identify на нормальном ходе → совпадение с числовым score", async () => {
    const v = new SherpaSpeakerVerifier(fakeExtractor());
    const profiles = [await makeProfile(v)];
    const m = await v.identify(frame(0.3, SR), profiles);
    expect(m).not.toBeNull();
    expect(m!.name).toBe("Антон");
    expect(Number.isFinite(m!.score)).toBe(true);
  });
});

/** Экстрактор, дающий РАЗНОЕ направление на каждый вызов — окна получаются несогласованными. */
function rotatingExtractor(dim = 4): SherpaExtractor {
  const bufs = new WeakMap<object, number[]>();
  let call = 0;
  return {
    dim,
    createStream() {
      const buf: number[] = [];
      const stream = { acceptWaveform(o: { samples: Float32Array }) { for (const s of o.samples) buf.push(s); }, inputFinished() {} };
      bufs.set(stream, buf);
      return stream;
    },
    isReady(s) {
      return (bufs.get(s)?.length ?? 0) >= 1600;
    },
    compute() {
      // Чередуем противоположные направления → центроид вырождается, self-check проваливается.
      const sign = call % 2 === 0 ? 1 : -1;
      call += 1;
      return new Float32Array([sign, 0, 0, 0]);
    },
  };
}

describe("§3 Фаза 1 — multi-sample центроид + self-check", () => {
  it("несогласованные окна (чередующиеся направления) → self-check НЕ пройден → null", async () => {
    const v = new SherpaSpeakerVerifier(rotatingExtractor());
    const s = v.enroll();
    for (let i = 0; i < 15; i += 1) await s.feed(frame(0.3, SR)); // 15с речи → ~4 окна
    expect(await s.finish()).toBeNull(); // мусорный/несогласованный эталон не сохраняем
  });

  it("согласованные окна → центроид сохраняется и опознаёт собственный голос", async () => {
    const v = new SherpaSpeakerVerifier(fakeExtractor());
    const profile = await makeProfile(v);
    const m = await v.identify(frame(0.3, SR), [profile]);
    expect(m).not.toBeNull();
    expect(m!.score).toBeGreaterThan(v.rejectThreshold); // свой проходит
  });
});

describe("§3 Фаза 0 — отбраковка профиля чужой модели/размерности", () => {
  it("identify пропускает (null) профиль с другой размерностью эмбеддинга", async () => {
    const v = new SherpaSpeakerVerifier(fakeExtractor(4));
    // Профиль «другой модели»: dim 8 (не 4). Косинус молча резал бы по min(len) → мусор; гейт должен отбраковать.
    const foreign: VoiceProfile = { name: "Чужая модель", data: new Uint8Array(8 * 4), createdAt: 0, dim: 8, modelId: "other-model" };
    expect(await v.identify(frame(0.3, SR), [foreign])).toBeNull();
  });

  it("identify сравнивает только с совместимыми профилями (смесь совместимый+чужой)", async () => {
    const v = new SherpaSpeakerVerifier(fakeExtractor(4));
    const ours = await makeProfile(v); // dim 4 (legacy-стиль без поля dim → выводится из длины)
    const foreign: VoiceProfile = { name: "Чужой", data: new Uint8Array(8 * 4), createdAt: 0, dim: 8 };
    const m = await v.identify(frame(0.3, SR), [foreign, ours]);
    expect(m).not.toBeNull();
    expect(m!.name).toBe("Антон"); // чужая размерность отброшена, опознан наш профиль
  });
});

describe("§3 Фаза 2 — пороги accept/reject", () => {
  it("reject ≤ accept = threshold, reject в допустимых границах", () => {
    const v = new SherpaSpeakerVerifier(fakeExtractor());
    expect(v.acceptThreshold).toBe(v.threshold);
    expect(v.rejectThreshold).toBeLessThanOrEqual(v.acceptThreshold);
    expect(v.rejectThreshold).toBeGreaterThanOrEqual(0.1);
  });
});
