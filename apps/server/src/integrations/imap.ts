/**
 * Минимальный IMAP-клиент (RFC 3501) на node:tls — ровно для одного вопроса: «лежит ли письмо с этим
 * Message-ID в «Отправленных»?» Это сверка ФАКТА отправки mail_send (причина №3 USER_SCENARIOS_2026-09-02):
 * SMTP «250 принято» — уже факт, IMAP — второй источник; при неопределённом SMTP-исходе (обрыв после
 * тела) — единственный способ не повторить письмо вслепую.
 *
 * Папка «Отправленные»: сперва по атрибуту \Sent (RFC 6154 SPECIAL-USE), иначе по известным именам.
 * Кириллические имена в IMAP — modified-UTF7 (например «Отправленные» = «&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-»);
 * поэтому список кандидатов включает и их закодированные формы.
 */
import { Socket, connect as netConnect } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  tls: "implicit" | "none";
  timeoutMs?: number;
}

export interface ImapFindResult {
  found: boolean;
  folder?: string;
  checkedFolders: string[];
}

export class ImapError extends Error {}

const DEFAULT_TIMEOUT_MS = 12_000;
/** Имена «Отправленных» у популярных провайдеров (ASCII и modified-UTF7 «Отправленные»). */
const SENT_CANDIDATES = ["Sent", "Sent Items", "Sent Messages", "[Gmail]/Sent Mail", "INBOX.Sent", "&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-", "INBOX/Sent"];

function quote(s: string): string {
  return `"${s.replace(/(["\\])/gu, "\\$1")}"`;
}

/** Ответы IMAP: копим строки до «<tag> OK|NO|BAD». */
class TaggedReader {
  private buf = "";
  private lines: string[] = [];
  private waiters: Array<{ tag: string; resolve: (r: { ok: boolean; lines: string[]; status: string }) => void }> = [];
  private closed?: Error;
  private untaggedSince = 0;
  feed(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const idx = this.buf.indexOf("\r\n");
      if (idx < 0) break;
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this.lines.push(line);
      const w = this.waiters[0];
      if (w && line.startsWith(`${w.tag} `)) {
        this.waiters.shift();
        const status = line.slice(w.tag.length + 1).split(" ")[0] ?? "";
        w.resolve({ ok: status === "OK", lines: this.lines.slice(this.untaggedSince), status: line.slice(w.tag.length + 1) });
        this.untaggedSince = this.lines.length;
      }
    }
  }
  close(err: Error): void {
    this.closed = err;
    for (const w of this.waiters.splice(0)) w.resolve({ ok: false, lines: [], status: `CLOSED ${err.message}` });
  }
  wait(tag: string): Promise<{ ok: boolean; lines: string[]; status: string }> {
    if (this.closed) return Promise.resolve({ ok: false, lines: [], status: `CLOSED ${this.closed.message}` });
    return new Promise((resolve) => this.waiters.push({ tag, resolve }));
  }
  /** Первая строка (приветствие «* OK»). */
  greeting(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.lines.length > 0) {
          this.untaggedSince = this.lines.length;
          resolve();
        } else setTimeout(check, 20);
      };
      check();
    });
  }
}

function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new ImapError(`IMAP: таймаут ${ms} мс (${what})`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Есть ли письмо с Message-ID в «Отправленных». Бросает ImapError на сбое соединения/логина. */
export async function imapFindMessage(cfg: ImapConfig, messageId: string): Promise<ImapFindResult> {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socket: Socket | TLSSocket = await deadline(
    new Promise<Socket | TLSSocket>((resolve, reject) => {
      const s =
        cfg.tls === "implicit"
          ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => resolve(s))
          : netConnect({ host: cfg.host, port: cfg.port }, () => resolve(s));
      s.once("error", reject);
    }),
    timeoutMs,
    "connect",
  );
  const reader = new TaggedReader();
  socket.setEncoding("utf8");
  socket.on("data", (d: string) => reader.feed(d));
  socket.on("error", (e) => reader.close(e instanceof Error ? e : new Error(String(e))));
  socket.on("close", () => reader.close(new Error("соединение закрыто")));
  let n = 0;
  const cmd = async (line: string): Promise<{ ok: boolean; lines: string[]; status: string }> => {
    n += 1;
    const tag = `a${n}`;
    socket.write(`${tag} ${line}\r\n`);
    return deadline(reader.wait(tag), timeoutMs, line.split(" ")[0] ?? line);
  };
  const checked: string[] = [];
  try {
    await deadline(reader.greeting(), timeoutMs, "greeting");
    const login = await cmd(`LOGIN ${quote(cfg.user)} ${quote(cfg.password)}`);
    if (!login.ok) throw new ImapError(`IMAP LOGIN отклонён: ${login.status.slice(0, 120)} (пароль приложения? IMAP включён в настройках ящика?)`);
    const list = await cmd('LIST "" "*"');
    const folders: Array<{ name: string; sent: boolean }> = [];
    for (const l of list.lines) {
      const m = /^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (?:"((?:[^"\\]|\\.)*)"|(\S+))$/u.exec(l);
      if (!m) continue;
      const name = (m[2] ?? m[3] ?? "").replace(/\\(.)/gu, "$1");
      folders.push({ name, sent: /\\Sent\b/iu.test(m[1] ?? "") });
    }
    const bySpecial = folders.filter((f) => f.sent).map((f) => f.name);
    const byName = SENT_CANDIDATES.filter((c) => folders.some((f) => f.name === c));
    const candidates = [...new Set([...bySpecial, ...byName])];
    for (const folder of candidates) {
      const sel = await cmd(`SELECT ${quote(folder)}`);
      if (!sel.ok) continue;
      checked.push(folder);
      const search = await cmd(`SEARCH HEADER Message-ID ${quote(messageId)}`);
      const hit = search.lines.find((l) => /^\* SEARCH\s+\d/u.test(l));
      if (search.ok && hit) return { found: true, folder, checkedFolders: checked };
    }
    return { found: false, checkedFolders: checked };
  } finally {
    try {
      socket.write("a999 LOGOUT\r\n");
    } catch {
      /* уже закрыт */
    }
    socket.destroy();
  }
}
