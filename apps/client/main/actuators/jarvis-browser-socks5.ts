/**
 * B-14 (rebinding): провод SOCKS5 (RFC 1928) для прокси пиннинга невидимого браузера — только то, что шлёт Chrome:
 * метод «без аутентификации» и CONNECT. Рукопожатие может прийти кусками. Политика (суд над адресом, подключение) —
 * в jarvis-browser-proxy.ts.
 */
import type { Socket } from "node:net";

/** Коды ответа (поле REP). */
export const REP = { ok: 0, ruleset: 2, unreachable: 4, refused: 5, command: 7, addressType: 8 } as const;

/** Ответ на CONNECT: BND.ADDR 0.0.0.0:0 (Chrome его не читает). */
export const reply = (rep: number): Buffer => Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0]);

const ipv6Text = (b: Buffer): string => Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(":");

/**
 * Читатель рукопожатия: копит куски `data` и отдаёт ровно n байт. НЕ `read(n)` + `readable`: при неполном буфере
 * повторная подписка на `readable` планирует его снова на nextTick — вечный цикл, event loop голодает (27.09, стенд).
 */
class Reader {
  private buf = Buffer.alloc(0);
  private closed = false;
  private wake?: () => void;
  private readonly onData = (c: Buffer): void => {
    this.buf = Buffer.concat([this.buf, c]);
    this.wake?.();
  };
  private readonly onEnd = (): void => {
    this.closed = true;
    this.wake?.();
  };

  constructor(private readonly sock: Socket) {
    sock.on("data", this.onData).on("end", this.onEnd).on("close", this.onEnd);
  }

  async take(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (this.closed) throw new Error("socks: соединение закрыто посреди рукопожатия");
      await new Promise<void>((r) => (this.wake = r));
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Отцепиться: поток на паузу, недочитанное — обратно в сокет (pipe отдаст его цели первым). */
  release(): void {
    this.sock.off("data", this.onData).off("end", this.onEnd).off("close", this.onEnd);
    this.sock.pause();
    if (this.buf.length && !this.sock.destroyed) this.sock.unshift(this.buf);
  }
}

const refuse = (sock: Socket, answer: Buffer): null => {
  sock.end(answer);
  return null;
};

/**
 * Рукопожатие → цель CONNECT. `raw` — хост как прислан (имя; IPv4/IPv6 — текстом, IPv6 — в скобках, как в URL).
 * null — отказ уже отправлен (не SOCKS5, нет метода «без аутентификации», не CONNECT, неизвестный тип адреса).
 */
export async function readConnectTarget(sock: Socket): Promise<{ raw: string; port: number } | null> {
  const r = new Reader(sock);
  try {
    const [ver, nMethods] = await r.take(2);
    if (ver !== 5) return refuse(sock, Buffer.alloc(0));
    if (!(await r.take(nMethods!)).includes(0)) return refuse(sock, Buffer.from([5, 0xff]));
    sock.write(Buffer.from([5, 0]));
    const [, cmd, , atyp] = await r.take(4);
    if (cmd !== 1) return refuse(sock, reply(REP.command));
    let raw: string;
    if (atyp === 1) raw = [...(await r.take(4))].join(".");
    else if (atyp === 3) raw = (await r.take((await r.take(1))[0]!)).toString("latin1");
    else if (atyp === 4) raw = ipv6Text(await r.take(16));
    else return refuse(sock, reply(REP.addressType));
    return { raw: raw.includes(":") && !raw.startsWith("[") ? `[${raw}]` : raw, port: (await r.take(2)).readUInt16BE(0) };
  } finally {
    r.release();
  }
}
