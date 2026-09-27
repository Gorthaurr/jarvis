/**
 * B-14 (rebinding): прокси пиннинга невидимого браузера на НАСТОЯЩИХ сокетах, без Chrome. Клиент говорит SOCKS5 как
 * Chrome (no-auth, CONNECT с именем); «цель» — TCP-сервер на 127.0.0.1 со счётчиком соединений. Факты — байты ответа,
 * счётчик соединений цели и сколько раз спрашивали резолвер.
 *
 * Реверт-проверки (из копии): сокет открывается по ИМЕНИ с резолвером (второй резолв) → «rebinding» красный (0x05 и
 * 2 вопроса DNS); суд пропущен → «имя → 127.0.0.1» красный (цель получила соединение); хост блока без канонической
 * записи (`urlHostname`) → «имя → 127.0.0.1» и «литералы» красные: запись прокси не совпала бы с ключом гарда
 * (`EVIL.Test.` ≠ `evil.test`, `[0:0:…:1]` ≠ `::1`), и честной ошибки перехода не было бы; общее правило без своих
 * сетей ПК (`local-nets.ts`) или суд без `interfaces` → «свой интерфейс» красный (и живой — на ПК с Radmin VPN).
 */
import { type Server, type Socket, connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { isPrivateIp } from "@jarvis/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type PinProxy, type ProxyBlock, startPinProxy } from "./jarvis-browser-proxy.js";

const TEST_NET = "203.0.113.10";

function client(port: number): { sock: Socket; read(n: number): Promise<Buffer>; closed(): boolean } {
  const sock = connect(port, "127.0.0.1");
  let buf = Buffer.alloc(0);
  let ended = false;
  const waiters: Array<() => void> = [];
  const wake = (): void => void waiters.splice(0).forEach((w) => w());
  sock.on("data", (c: Buffer) => ((buf = Buffer.concat([buf, c])), wake()));
  sock.on("close", () => ((ended = true), wake()));
  sock.on("error", () => undefined);
  const read = async (n: number): Promise<Buffer> => {
    while (buf.length < n && !ended) await new Promise<void>((r) => waiters.push(r));
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };
  return { sock, read, closed: () => ended };
}

const port16 = (p: number): Buffer => Buffer.from([p >> 8, p & 0xff]);
const byName = (host: string, port: number): Buffer => Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), Buffer.from(host, "latin1"), port16(port)]);

/** Приветствие + CONNECT → байт REP ответа (и клиент для дальнейшего обмена). */
async function connectVia(proxyPort: number, request: Buffer, chunked = false): Promise<{ rep: number; c: ReturnType<typeof client> }> {
  const c = client(proxyPort);
  const all = Buffer.concat([Buffer.from([5, 1, 0]), request]);
  if (chunked) {
    // Рукопожатие по байту: разбор не должен ждать «целого пакета».
    c.sock.write(all.subarray(0, 3));
    expect([...(await c.read(2))]).toEqual([5, 0]);
    for (const b of all.subarray(3)) {
      c.sock.write(Buffer.from([b]));
      await new Promise((r) => setTimeout(r, 2));
    }
  } else {
    c.sock.write(all.subarray(0, 3));
    expect([...(await c.read(2))]).toEqual([5, 0]);
    c.sock.write(all.subarray(3));
  }
  const rep = await c.read(10);
  return { rep: rep.length === 10 ? rep[1]! : -1, c };
}

describe("B-14: SOCKS5-прокси пиннинга — суд над адресом и подключение ровно к проверенному", () => {
  let target: Server;
  let targetPort = 0;
  let accepted = 0;
  let proxy: PinProxy;
  let asked: string[] = [];
  let answers: Record<string, string[][]> = {};
  const blocks: ProxyBlock[] = [];

  beforeAll(async () => {
    target = createServer((s) => {
      accepted += 1;
      s.on("error", () => undefined);
      s.on("data", (d: Buffer) => s.write(`PUBLIC:${d.toString()}`));
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
    const a = target.address();
    targetPort = typeof a === "object" && a ? a.port : 0;
    proxy = await startPinProxy({
      // «DNS»: по очереди из answers[host] (последний ответ повторяется); нет имени — не разрешается.
      lookup: async (host) => {
        asked.push(host);
        const q = answers[host];
        if (!q) throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
        return q.length > 1 ? q.shift()! : q[0]!;
      },
      mapAddress: (ip) => (ip === TEST_NET ? "127.0.0.1" : ip),
      onBlock: (b) => blocks.push(b),
    });
  });

  afterEach(() => {
    asked = [];
    answers = {};
    accepted = 0;
    blocks.length = 0;
  });

  afterAll(async () => {
    proxy?.close();
    await new Promise((r) => target.close(() => r(undefined)));
  });

  it("публичное имя: ответ 0x00, байты ходят к проверенному адресу, DNS спрошен один раз", async () => {
    answers["shop.test"] = [[TEST_NET]];
    const { rep, c } = await connectVia(proxy.port, byName("shop.test", targetPort));
    expect(rep).toBe(0);
    c.sock.write("ping");
    expect((await c.read(11)).toString()).toBe("PUBLIC:ping");
    expect(asked).toEqual(["shop.test"]);
    c.sock.destroy();
  });

  it("рукопожатие кусками по байту — разбирается так же", async () => {
    answers["shop.test"] = [[TEST_NET]];
    const { rep, c } = await connectVia(proxy.port, byName("shop.test", targetPort), true);
    expect(rep).toBe(0);
    c.sock.destroy();
  });

  it("rebinding: суду — публичный, следующему резолву — 127.0.0.2; сокет открыт к ПРОВЕРЕННОМУ, второго резолва нет", async () => {
    // 127.0.0.2 — loopback, где цель НЕ слушает: подключение по второму ответу дало бы отказ (0x05), а не 0x00.
    answers["rebind.test"] = [[TEST_NET], ["127.0.0.2"]];
    const { rep, c } = await connectVia(proxy.port, byName("rebind.test", targetPort));
    expect(rep).toBe(0);
    c.sock.write("x");
    expect((await c.read(8)).toString()).toBe("PUBLIC:x");
    expect(asked).toEqual(["rebind.test"]);
    c.sock.destroy();
  });

  it("имя → 127.0.0.1 и мультизапись «публичный + 127.0.0.1»: 0x02, блок в журнале, цель без соединений", async () => {
    answers["evil.test"] = [["127.0.0.1"]];
    answers["mixed.test"] = [[TEST_NET, "127.0.0.1"]];
    for (const host of ["EVIL.Test.", "mixed.test"]) {
      const { rep, c } = await connectVia(proxy.port, byName(host, targetPort));
      expect(rep, host).toBe(2);
      c.sock.destroy();
    }
    expect(accepted).toBe(0);
    expect(blocks).toEqual([
      { host: "evil.test", port: targetPort, reason: "private" },
      { host: "mixed.test", port: targetPort, reason: "private" },
    ]);
    expect(proxy.blocked.slice(-2).map((b) => b.host)).toEqual(["evil.test", "mixed.test"]);
  });

  it("литералы loopback любым типом адреса (строкой, IPv4, IPv6 ::1 и ::ffff:127.0.0.1 байтами) → 0x02 без DNS", async () => {
    const v6 = (hex: number[]): Buffer => Buffer.concat([Buffer.from([5, 1, 0, 4]), Buffer.from(hex.flatMap((h) => [h >> 8, h & 0xff])), port16(targetPort)]);
    const requests = [
      byName("127.0.0.1", targetPort),
      Buffer.concat([Buffer.from([5, 1, 0, 1, 127, 0, 0, 1]), port16(targetPort)]),
      v6([0, 0, 0, 0, 0, 0, 0, 1]),
      v6([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]),
    ];
    for (const req of requests) {
      const { rep, c } = await connectVia(proxy.port, req);
      expect(rep, req.toString("hex")).toBe(2);
      c.sock.destroy();
    }
    expect(asked).toEqual([]);
    expect(accepted).toBe(0);
    // Запись блока — в канонической форме гарда (`urlHostname` адреса документа): иначе сопоставление не сработает.
    expect(blocks.map((b) => b.host)).toEqual(["127.0.0.1", "127.0.0.1", "::1", "::ffff:7f00:1"]);
  });

  it("имя → адрес СВОЕГО интерфейса (Radmin VPN) или соседа по его сети, литерал такого адреса → 0x02, цель без соединений", async () => {
    // TEST-NET-2 в роли 26.106.17.249/8 (не задевает TEST_NET остальных кейсов); без суда подмена увела бы на цель.
    const own = await startPinProxy({
      lookup: async (h) => {
        const a = ({ "radmin.test": ["198.51.100.7"], "peer.test": ["198.51.100.200"] } as Record<string, string[]>)[h];
        if (!a) throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
        return a;
      },
      interfaces: () => ({ "Radmin VPN": [{ address: "198.51.100.7", cidr: "198.51.100.7/24" }] }),
      mapAddress: (ip) => (ip.startsWith("198.51.100.") ? "127.0.0.1" : ip),
    });
    try {
      for (const req of [byName("radmin.test", targetPort), byName("peer.test", targetPort), Buffer.concat([Buffer.from([5, 1, 0, 1, 198, 51, 100, 7]), port16(targetPort)])]) {
        const { rep, c } = await connectVia(own.port, req);
        expect(rep, req.toString("hex")).toBe(2);
        c.sock.destroy();
      }
      expect(accepted).toBe(0);
      expect(own.blocked.map((b) => `${b.host}:${b.reason}`)).toEqual(["radmin.test:private", "peer.test:private", "198.51.100.7:private"]);
    } finally {
      own.close();
    }
  });

  it("имя не разрешилось → 0x04 (unresolved), цель без соединений", async () => {
    const { rep, c } = await connectVia(proxy.port, byName("nx.test", targetPort));
    expect(rep).toBe(4);
    expect(blocks.map((b) => b.reason)).toEqual(["unresolved"]);
    expect(accepted).toBe(0);
    c.sock.destroy();
  });

  it("не CONNECT (BIND) → 0x07; нет метода «без аутентификации» → 05 FF и закрытие", async () => {
    const bind = await connectVia(proxy.port, Buffer.concat([Buffer.from([5, 2, 0, 1, 1, 2, 3, 4]), port16(80)]));
    expect(bind.rep).toBe(7);
    bind.c.sock.destroy();
    const c = client(proxy.port);
    c.sock.write(Buffer.from([5, 1, 2]));
    expect([...(await c.read(2))]).toEqual([5, 0xff]);
    await c.read(1);
    expect(c.closed()).toBe(true);
  });
});

// Живой факт адверс-ревью 27.09 в той форме, в какой он был: слушатель на 0.0.0.0 (как PostgreSQL 5432, preview 4599),
// имя → НАСТОЯЩИЙ адрес интерфейса этого ПК вне диапазонов RFC1918 (на ПК владельца — Radmin VPN 26.106.17.249), суд —
// по системному списку интерфейсов (без DI). Раньше: REP 0x00 и соединение у слушателя. Нет такого адреса — пропуск.
const ownOutsideRanges = Object.values(networkInterfaces())
  .flatMap((l) => l ?? [])
  .filter((a) => a.family === "IPv4" && !isPrivateIp(a.address, () => ({})))
  .map((a) => a.address);

describe.skipIf(!ownOutsideRanges.length)("B-14: живой — свой адрес ПК вне RFC1918 (Radmin VPN), слушатель на 0.0.0.0", () => {
  it("имя → свой адрес: 0x02, слушатель на 0.0.0.0 соединения не получил", async () => {
    let got = 0;
    const listener = createServer((s) => ((got += 1), s.destroy()));
    await new Promise<void>((r) => listener.listen(0, "0.0.0.0", () => r()));
    const a = listener.address();
    const port = typeof a === "object" && a ? a.port : 0;
    const proxy = await startPinProxy({ lookup: async () => ownOutsideRanges.slice(0, 1) });
    try {
      const { rep, c } = await connectVia(proxy.port, byName("radmin-live.test", port));
      expect(rep).toBe(2);
      c.sock.destroy();
      await new Promise((r) => setTimeout(r, 100));
      expect(got).toBe(0);
    } finally {
      proxy.close();
      await new Promise((r) => listener.close(() => r(undefined)));
    }
  });
});
