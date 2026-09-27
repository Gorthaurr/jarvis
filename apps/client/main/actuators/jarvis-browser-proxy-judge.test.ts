/**
 * B-14 (адверс-ревью): суд пиннинг-прокси не даёт странице забить пул getaddrinfo главного процесса. Настоящий
 * HostJudge, резолвер — управляемые промисы (видно, сколько резолвов идёт разом и когда отпущены).
 *
 * Реверт-проверки (из копии): одноярусное имя идёт в резолвер → «интранет» красный; слот отпускается по таймауту
 * вердикта, а не по ответу резолвера → «слот до ответа» красный; нет дедупа/кеша → «одно имя — один резолв» красный;
 * ушедший клиент всё равно резолвится → «снят из очереди» красный; слотов больше одного → «по одному» красный;
 * слот не отпускается при ошибке резолвера → «резолвер бросил» красный (прокси умер бы на первом NXDOMAIN); кеш без
 * лимита → «лимит кеша» красный; IPv6-литерал принят за одноярусное имя → «литералы» красный; литерал через кеш/слот
 * или адреса кеша без пересуда → «VPN подключился после суда» красные (адверс-ревью р1 своих адресов ПК).
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

  it("одно имя: в полёте — один резолв, публичный вердикт помнится 40 с (≥ окна гарда 35 с), потом спрашиваем заново", async () => {
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
    vi.setSystemTime(Date.now() + 36_000);
    expect(await j.judge("web.telegram.org")).toEqual(await a); // в окне сопоставления гарда — ещё из кеша
    expect(m.asked).toHaveLength(1);
    vi.setSystemTime(Date.now() + 5_000);
    const c = j.judge("web.telegram.org");
    await vi.waitFor(() => expect(m.asked).toHaveLength(2));
    m.answer(1, ["127.0.0.1"]);
    expect(await c).toMatchObject({ ok: false, reason: "private" });
  });

  it("резолвер бросил (NXDOMAIN) → слот отпущен, следующее имя резолвится", async () => {
    const asked: string[] = [];
    const j = new HostJudge({
      lookup: async (h) => {
        asked.push(h);
        if (h === "nx.test") throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
        return ["203.0.113.10"];
      },
    });
    expect(await j.judge("nx.test")).toMatchObject({ ok: false, reason: "unresolved" });
    expect((await j.judge("ok.test")).ok).toBe(true);
    expect(asked).toEqual(["nx.test", "ok.test"]);
  });

  it("литералы IPv4/IPv6 — не интранет: публичный проходит без резолва, loopback — отказ", async () => {
    const m = manualLookup();
    const j = new HostJudge({ lookup: m.lookup });
    expect(await j.judge("8.8.8.8")).toEqual({ ok: true, addresses: ["8.8.8.8"] });
    expect(await j.judge("2001:4860:4860::8888")).toEqual({ ok: true, addresses: ["2001:4860:4860::8888"] });
    expect(await j.judge("::1")).toMatchObject({ ok: false, reason: "private" });
    expect(m.asked).toEqual([]);
  });

  it("VPN подключился после суда: литерал его сети — приватен сразу (без кеша) и не ждёт слота за зависшим резолвом", async () => {
    let vpn = false;
    const interfaces = () => (vpn ? { "Radmin VPN": [{ address: "198.51.100.7", cidr: "198.51.100.7/24" }] } : {});
    const m = manualLookup();
    const j = new HostJudge({ lookup: m.lookup, interfaces });
    const hung = j.judge("hung.test"); // единственный слот занят: резолвер молчит
    await vi.waitFor(() => expect(m.asked).toEqual(["hung.test"]));
    expect(await j.judge("198.51.100.9")).toEqual({ ok: true, addresses: ["198.51.100.9"] });
    vpn = true;
    expect(await j.judge("198.51.100.9")).toEqual({ ok: false, reason: "private", address: "198.51.100.9" });
    expect(m.asked).toEqual(["hung.test"]);
    m.answer(0);
    await hung;
  });

  it("VPN подключился после суда: имя с публичным вердиктом в кеше → адрес пересужен, приватен сразу, DNS не спрошен", async () => {
    let vpn = false;
    const interfaces = () => (vpn ? { "Radmin VPN": [{ address: "198.51.100.7", cidr: "198.51.100.7/24" }] } : {});
    const asked: string[] = [];
    const j = new HostJudge({ lookup: async (h) => (asked.push(h), ["198.51.100.200"]), interfaces });
    expect(await j.judge("peer.test")).toEqual({ ok: true, addresses: ["198.51.100.200"] });
    vpn = true;
    expect(await j.judge("peer.test")).toEqual({ ok: false, reason: "private", address: "198.51.100.200" });
    expect(asked).toEqual(["peer.test"]);
    vpn = false;
    expect(await j.judge("peer.test")).toMatchObject({ ok: true }); // отказ из кеша не живёт: спросили заново
    expect(asked).toEqual(["peer.test", "peer.test"]);
  });

  it("лимит кеша: 300 имён — самое старое вытеснено и спрашивается заново, свежее — из кеша", async () => {
    const asked: string[] = [];
    const j = new HostJudge({ lookup: async (h) => (asked.push(h), ["203.0.113.10"]) });
    for (let i = 0; i < 300; i++) await j.judge(`h${i}.test`);
    asked.length = 0;
    await j.judge("h299.test");
    expect(asked).toEqual([]);
    await j.judge("h0.test");
    expect(asked).toEqual(["h0.test"]);
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
