import { describe, expect, it } from "vitest";
import { SidecarSpeakerVerifier } from "./verifier-sidecar.js";
import {
  type HostRequest,
  type HostResponse,
  b64ToBytes,
  b64ToPcm,
  bytesToB64,
  createLineParser,
  pcmToB64,
} from "./sidecar-protocol.js";
import type { VoiceProfile } from "./verifier.js";

const HELLO: Extract<HostResponse, { t: "hello" }> = {
  t: "hello",
  ready: true,
  dim: 192,
  modelId: "campp-3dspeaker-192",
  threshold: 0.35,
  acceptThreshold: 0.35,
  rejectThreshold: 0.31,
  enrollSeconds: 12,
};

function makeProxy(opts?: { alive?: boolean; timeoutMs?: number }) {
  const sent: HostRequest[] = [];
  let live = opts?.alive ?? true;
  const proxy = new SidecarSpeakerVerifier({
    hello: HELLO,
    send: (r) => sent.push(r),
    alive: () => live,
    timeoutMs: opts?.timeoutMs ?? 8_000,
  });
  return { proxy, sent, kill: () => (live = false) };
}

const PROFILE: VoiceProfile = { name: "Антон", data: new Uint8Array([1, 2, 3, 4]), createdAt: 1, dim: 1, modelId: "m" };

describe("sidecar-protocol кодеки", () => {
  it("pcm round-trip сохраняет Int16 (вкл. отрицательные/границы)", () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768, 12345]);
    expect(Array.from(b64ToPcm(pcmToB64(pcm)))).toEqual(Array.from(pcm));
  });
  it("bytes round-trip", () => {
    const u = new Uint8Array([0, 255, 7, 128]);
    expect(Array.from(b64ToBytes(bytesToB64(u)))).toEqual([0, 255, 7, 128]);
  });
  it("createLineParser режет по \\n, парсит кадры с t, игнорит не-JSON и без t", () => {
    const frames: Array<{ t: string }> = [];
    const feed = createLineParser<{ t: string }>((f) => frames.push(f));
    feed('{"t":"a"}\nнативный мусор sherpa\n');
    feed('{"no":"t"}\n{"t":'); // незавершённая строка — ждём продолжения
    feed('"b"}\n');
    expect(frames.map((f) => f.t)).toEqual(["a", "b"]); // мусор и {no:t} отброшены
  });
});

describe("SidecarSpeakerVerifier (прокси §3)", () => {
  it("прокидывает поля движка из hello", () => {
    const { proxy } = makeProxy();
    expect(proxy.ready).toBe(true);
    expect(proxy.dim).toBe(192);
    expect(proxy.modelId).toBe("campp-3dspeaker-192");
    expect(proxy.acceptThreshold).toBe(0.35);
    expect(proxy.rejectThreshold).toBe(0.31);
    expect(proxy.enrollSeconds).toBe(12);
  });

  it("identify форвардит запрос и резолвит ответ по id", async () => {
    const { proxy, sent } = makeProxy();
    const p = proxy.identify(new Int16Array([5, 6, 7]), [PROFILE]);
    const req = sent.at(-1)!;
    expect(req.t).toBe("identify");
    proxy.receive({ t: "identify.res", id: (req as Extract<HostRequest, { t: "identify" }>).id, match: { name: "Антон", score: 0.82 } });
    expect(await p).toEqual({ name: "Антон", score: 0.82 });
  });

  it("identify без профилей → null, БЕЗ запроса в сайдкар", async () => {
    const { proxy, sent } = makeProxy();
    expect(await proxy.identify(new Int16Array([1]), [])).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("enroll: start/feed/finish форвардятся и резолвятся", async () => {
    const { proxy, sent } = makeProxy();
    const sess = proxy.enroll();
    expect(sent.at(-1)?.t).toBe("enroll.start");

    const pf = sess.feed(new Int16Array([1, 2]));
    const feedReq = sent.at(-1) as Extract<HostRequest, { t: "enroll.feed" }>;
    expect(feedReq.t).toBe("enroll.feed");
    proxy.receive({ t: "enroll.feed.res", id: feedReq.id, pct: 0.5 });
    expect(await pf).toBe(0.5);

    const ff = sess.finish();
    const finReq = sent.at(-1) as Extract<HostRequest, { t: "enroll.finish" }>;
    expect(finReq.t).toBe("enroll.finish");
    proxy.receive({ t: "enroll.finish.res", id: finReq.id, data: bytesToB64(new Uint8Array([9, 8, 7])) });
    expect(Array.from((await ff)!)).toEqual([9, 8, 7]);
  });

  it("мёртвый канал → identify null / feed 0 / finish null, без отправки", async () => {
    const { proxy, sent, kill } = makeProxy();
    kill();
    expect(await proxy.identify(new Int16Array([1]), [PROFILE])).toBeNull();
    const sess = proxy.enroll();
    expect(await sess.feed(new Int16Array([1]))).toBe(0);
    expect(await sess.finish()).toBeNull();
    expect(sent).toHaveLength(0); // ничего не ушло в мёртвый канал
  });

  it("таймаут без ответа → null (fail-open), pending очищается", async () => {
    const { proxy } = makeProxy({ timeoutMs: 20 });
    expect(await proxy.identify(new Int16Array([1]), [PROFILE])).toBeNull();
  });

  it("fail() резолвит ожидающих в null (канал упал)", async () => {
    const { proxy } = makeProxy();
    const p = proxy.identify(new Int16Array([1]), [PROFILE]);
    proxy.fail();
    expect(await p).toBeNull();
  });

  it("L3: dispose() убивает дочерний процесс (kill) и резолвит ожидающих в null (fail-open)", async () => {
    let killed = 0;
    let live = true;
    const proxy = new SidecarSpeakerVerifier({
      hello: HELLO,
      send: () => {},
      alive: () => live,
      kill: () => {
        killed += 1;
        live = false;
      },
    });
    const p = proxy.identify(new Int16Array([1]), [PROFILE]); // ожидание в полёте
    proxy.dispose();
    expect(killed).toBe(1); // дочерний процесс убит (иначе зомби с моделью в памяти)
    expect(await p).toBeNull(); // ожидание резолвлено в null (гейт пропускает — fail-open)
  });

  it("L3: dispose() без kill в deps не бросает (юнит-путь без spawn)", () => {
    const { proxy } = makeProxy();
    expect(() => proxy.dispose()).not.toThrow();
  });
});
