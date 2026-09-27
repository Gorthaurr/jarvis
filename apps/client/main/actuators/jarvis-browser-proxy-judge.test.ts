/**
 * B-14 (адверс-ревью): суд пиннинг-прокси не даёт странице забить пул getaddrinfo главного процесса. Настоящий
 * HostJudge, резолвер — управляемые промисы (видно, сколько резолвов идёт разом и когда отпущены).
 *
 * Реверт-проверки (из копии): одноярусное имя идёт в резолвер → «интранет» красный; слот отпускается по таймауту
 * вердикта, а не по ответу резолвера → «слот до ответа» красный; нет дедупа/кеша → «одно имя — один резолв» красный;
 * ушедший клиент всё равно резолвится → «снят из очереди» красный; слотов больше одного → «по одному» красный.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostJudge } from "./jarvis-browser-proxy-judge.js";

/** Резолвер, чьими ответами управляет тест: asked — порядок вопросов, answer(i) — ответить на i-й. */
function manualLookup() {
  const asked: string[] = [];
  const pending: Array<(a: string[]) => void> = [];
  let live = 0;
  let peak = 0;
  const lookup = (host: string): Promise<string[]> => {
    asked.push(host);
    live += 1;
    peak = Math.max(peak, live);
    return new Promise<string[]>((r) => pending.push((a) => ((live -= 1), r(a))));
  };
  return { lookup, asked, answer: (i: number, a = ["203.0.113.10"]) => pending[i]!(a), peak: () => peak };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => void vi.useRealTimers());

describe("B-14: суд пиннинг-прокси бережёт пул резолвера", () => {
  it("одноярусное имя — интранет: отказ «private» без вопроса резолверу", async () => {
    const m = manualLookup();
    const j = new HostJudge({ lookup: m.lookup });
    expect(await j.judge("router")).toEqual({ ok: false, reason: "private", address: "router" });
    expect(await j.judge("jx1")).toMatchObject({ ok: false, reason: "private" });
    expect(m.asked).toEqual([]);
  });

  it("резолвы — по одному (второй поток getaddrinfo остаётся гарду): 6 разных имён — пик 1, остальные ждут", async () => {
    const m = manualLookup();
    const j = new HostJudge({ lookup: m.lookup });
    const all = ["a", "b", "c", "d", "e", "f"].map((h) => j.judge(`${h}.test`));
    await tick();
    expect(m.asked).toEqual(["a.test"]);
    for (let i = 0; i < 6; i++) {
      await vi.waitFor(() => expect(m.asked.length).toBeGreaterThan(i));
      m.answer(i);
    }
    expect((await Promise.all(all)).every((v) => v.ok)).toBe(true);
    expect(m.peak()).toBe(1);
  });

  it("клиент ушёл, пока ждал слота — его имя не резолвится (очередь не переживает страницу)", async () => {
    const m = manualLookup();
    const j = new HostJudge({ lookup: m.lookup });
    const busy = j.judge("busy.test");
    let gone = false;
    const dropped = j.judge("gone.test", () => !gone);
    await tick();
    gone = true; // Chrome закрыл сокет — страница ушла
    m.answer(0);
    expect((await busy).ok).toBe(true);
    expect(await dropped).toMatchObject({ ok: false, reason: "unresolved" });
    expect(m.asked).toEqual(["busy.test"]);
  });

  it("слот держится до ОТВЕТА резолвера, а не до таймаута вердикта (поток getaddrinfo ещё занят)", async () => {
    const m = manualLookup();
    const j = new HostJudge({ lookup: m.lookup, slots: 1, timeoutMs: 100 });
    expect(await j.judge("slow.test")).toMatchObject({ ok: false, reason: "unresolved" });
    const next = j.judge("next.test");
    await new Promise((r) => setTimeout(r, 150));
    expect(m.asked).toEqual(["slow.test"]); // слот ещё у зависшего резолва
    m.answer(0);
    await vi.waitFor(() => expect(m.asked).toEqual(["slow.test", "next.test"]), { interval: 2 });
    m.answer(1);
    expect((await next).ok).toBe(true);
  });

  it("одно имя: в полёте — один резолв, публичный вердикт помнится 30 с, потом спрашиваем заново", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const m = manualLookup();
    const j = new HostJudge({ lookup: m.lookup });
    const [a, b] = [j.judge("web.telegram.org"), j.judge("web.telegram.org")];
    await vi.waitFor(() => expect(m.asked).toHaveLength(1));
    m.answer(0, ["149.154.167.99"]);
    expect(await a).toEqual({ ok: true, addresses: ["149.154.167.99"] });
    expect(await b).toEqual(await a);
    expect(await j.judge("web.telegram.org")).toEqual(await a);
    expect(m.asked).toHaveLength(1);
    vi.setSystemTime(Date.now() + 31_000);
    const c = j.judge("web.telegram.org");
    await vi.waitFor(() => expect(m.asked).toHaveLength(2));
    m.answer(1, ["127.0.0.1"]);
    expect(await c).toMatchObject({ ok: false, reason: "private" });
  });

  it("отказ не кешируется: приватный ответ спрашивается заново", async () => {
    const m = manualLookup();
    const j = new HostJudge({ lookup: m.lookup });
    const first = j.judge("evil.test");
    await vi.waitFor(() => expect(m.asked).toHaveLength(1));
    m.answer(0, ["127.0.0.1"]);
    expect((await first).ok).toBe(false);
    const second = j.judge("evil.test");
    await vi.waitFor(() => expect(m.asked).toHaveLength(2));
    m.answer(1);
    expect((await second).ok).toBe(true);
  });
});
