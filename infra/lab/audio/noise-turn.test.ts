import { describe, expect, it } from "vitest";
import { micChain } from "./mic-model.js";
import { makeNoise, mixRoom } from "./noise.js";
import { type LabEvent, buildTurn, recognized } from "./turn-collect.js";

const rms = (x: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < x.length; i += 1) s += (x[i] as number) ** 2;
  return Math.sqrt(s / x.length);
};

describe("сгенерированный фон", () => {
  it("уровни в СЫРОМ мике: тишина 0, комната ≈0,001, ТВ ≈0,008; после makeup комната ниже порога энерго-VAD 700", () => {
    expect(rms(makeNoise("silence", 1000))).toBe(0);
    expect(rms(makeNoise("room", 2000))).toBeCloseTo(0.001, 4);
    expect(rms(makeNoise("tv", 4000))).toBeCloseTo(0.008, 4);
    expect(rms(micChain(makeNoise("room", 2000)))).toBeLessThan(700);
  });

  it("детерминирован по seed и различается между seed", () => {
    expect(makeNoise("tv", 500, 3)).toEqual(makeNoise("tv", 500, 3));
    expect(makeNoise("tv", 500, 3)).not.toEqual(makeNoise("tv", 500, 4));
  });

  it("ТВ речеподобный: огибающая с паузами (есть и громкие, и практически тихие 20-мс окна)", () => {
    const x = makeNoise("tv", 6000);
    const w: number[] = [];
    for (let o = 0; o + 320 <= x.length; o += 320) w.push(rms(x.subarray(o, o + 320)));
    expect(Math.max(...w)).toBeGreaterThan(0.02);
    expect(w.filter((v) => v < 0.001).length).toBeGreaterThan(10);
  });

  it("mixRoom выдерживает заданный SNR", () => {
    const sig = Float32Array.from({ length: 16_000 }, (_, i) => 0.3 * Math.sin(i / 7));
    const mixed = mixRoom(sig, 20);
    const noise = mixed.map((v, i) => v - sig[i]!);
    expect(20 * Math.log10(rms(sig) / rms(noise))).toBeCloseTo(20, 0);
  });
});

const ev = (dir: "in" | "out", type: string, payload: unknown, at = 0): LabEvent => ({ at, dir, type, payload });

describe("сборка TurnResult из сырых событий", () => {
  const evs: LabEvent[] = [
    ev("in", "client.state", { state: "listening" }),
    ev("in", "chat", { role: "user", text: "включи музыку" }, 10),
    ev("in", "client.state", { state: "thinking" }),
    ev("in", "action.command", { kind: "media.control", action: "play" }, 100),
    ev("out", "action.result", { commandId: "c1", ok: true }, 140),
    ev("in", "user.confirm.request", { requestId: "r1", summary: "отправить?", kind: "send" }),
    ev("out", "user.confirm.result", { requestId: "r1", approved: true }),
    ev("in", "task.status", { taskId: "t1", state: "running", title: "Музыка" }),
    ev("in", "task.status", { taskId: "t1", state: "done" }),
    ev("in", "chat", { role: "assistant", text: "Включил, сэр." }),
    ev("in", "transcript", { text: "Включил, сэр.", final: true }),
    ev("in", "ui.display", { title: "Плейлист", markdown: "- трек" }),
    ev("in", "error", { code: "internal", message: "сбой" }),
  ];

  it("transcript = chat{user} (что распознал STT), а не сообщение transcript (ответ ассистента)", () => {
    expect(recognized(evs)).toBe("включи музыку");
  });

  it("собирает ответ, действия, подтверждения, задачи, карточки, состояния и ошибки сервера", () => {
    const t = buildTurn("x.wav", evs, { ms: 5, ended: "idle", speech: { chunks: 2, bytes: 10 } });
    expect(t.answer).toBe("Включил, сэр.");
    expect(t.actions).toHaveLength(1);
    expect(t.actions[0]?.ms).toBe(40);
    expect(t.confirms).toEqual([{ summary: "отправить?", kind: "send", answer: "yes" }]);
    expect(t.tasks).toEqual([{ taskId: "t1", state: "done", title: "Музыка" }]);
    expect(t.cards).toEqual([{ title: "Плейлист", markdown: "- трек" }]);
    expect(t.states).toEqual(["listening", "thinking"]);
    expect(t.serverErrors).toEqual(["internal: сбой"]);
    expect(t.ok).toBe(false); // ошибка сервера в ходе — не «ok»
  });

  it("таймаут — не ok; исходящие события (dir=out) не попадают в chat/states", () => {
    const t = buildTurn("y", [ev("out", "chat", { role: "user", text: "эхо" })], { ms: 1, ended: "timeout", speech: { chunks: 0, bytes: 0 } });
    expect(t.ok).toBe(false);
    expect(t.chat).toEqual([]);
  });
});
