/**
 * mail_send через РЕАЛЬНЫЙ dispatchTool против ФЕЙКОВЫХ SMTP/IMAP-серверов на loopback (net, без TLS —
 * MAIL_SMTP_TLS=none / MAIL_IMAP_TLS=none). Честность исходов: 250 → sent:true; отказ RCPT → ошибка, не
 * ушло; обрыв после тела + нет в «Отправленных» → «не знаю» (uncertain), повтор не вслепую; гейты §14:
 * подтверждение адресата, дедуп повтора, конфигурация отсутствует → честная ошибка с тем, что завести.
 */
import { type AddressInfo, type Server, type Socket, createServer } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatchTool, type ToolContext } from "../dispatch.js";
import { _resetResendGuardForTest } from "./messaging.js";

interface FakeSmtp {
  server: Server;
  port: number;
  messages: string[];
  rejectRcpt: boolean;
  dropAfterData: boolean;
}
function fakeSmtp(): Promise<FakeSmtp> {
  const st: FakeSmtp = { server: createServer(), port: 0, messages: [], rejectRcpt: false, dropAfterData: false };
  st.server.on("connection", (sock: Socket) => {
    let inData = false;
    let data = "";
    sock.on("error", () => undefined); // клиент рвёт соединение destroy() — не ронять тест ECONNRESET
    sock.write("220 fake ESMTP\r\n");
    sock.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      if (inData) {
        data += s;
        const end = data.indexOf("\r\n.\r\n");
        if (end >= 0) {
          st.messages.push(data.slice(0, end));
          inData = false;
          data = "";
          if (st.dropAfterData) sock.destroy();
          else sock.write("250 2.0.0 Ok: queued as 42\r\n");
        }
        return;
      }
      for (const line of s.split("\r\n").filter(Boolean)) {
        const u = line.toUpperCase();
        if (u.startsWith("EHLO")) sock.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (u.startsWith("AUTH PLAIN")) sock.write("235 ok\r\n");
        else if (u.startsWith("MAIL FROM")) sock.write("250 ok\r\n");
        else if (u.startsWith("RCPT TO")) sock.write(st.rejectRcpt ? "550 5.1.1 no such user\r\n" : "250 ok\r\n");
        else if (u === "DATA") {
          inData = true;
          sock.write("354 go\r\n");
        } else if (u === "QUIT") sock.write("221 bye\r\n");
        else sock.write("250 ok\r\n");
      }
    });
  });
  return new Promise((resolve) =>
    st.server.listen(0, "127.0.0.1", () => {
      st.port = (st.server.address() as AddressInfo).port; // ТОТ ЖЕ объект: флаги/массив теста видит сервер
      resolve(st);
    }),
  );
}

interface FakeImap {
  server: Server;
  port: number;
  /** Message-ID, которые «лежат в Отправленных». */
  sentIds: Set<string>;
}
function fakeImap(): Promise<FakeImap> {
  const st: FakeImap = { server: createServer(), port: 0, sentIds: new Set() };
  st.server.on("connection", (sock: Socket) => {
    sock.on("error", () => undefined);
    sock.write("* OK fake IMAP ready\r\n");
    sock.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\r\n").filter(Boolean)) {
        const [tag, cmd, ...rest] = line.split(" ");
        const c = (cmd ?? "").toUpperCase();
        if (c === "LOGIN") sock.write(`${tag} OK logged in\r\n`);
        else if (c === "LIST") sock.write(`* LIST (\\HasNoChildren \\Sent) "/" "Sent"\r\n* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK list done\r\n`);
        else if (c === "SELECT") sock.write(`* 3 EXISTS\r\n${tag} OK [READ-WRITE] selected\r\n`);
        else if (c === "SEARCH") {
          const id = rest.join(" ").match(/"([^"]+)"/u)?.[1] ?? "";
          sock.write(st.sentIds.has(id) ? `* SEARCH 3\r\n${tag} OK done\r\n` : `* SEARCH\r\n${tag} OK done\r\n`);
        } else if (c === "LOGOUT") sock.write(`* BYE\r\n${tag} OK\r\n`);
        else sock.write(`${tag} BAD unknown\r\n`);
      }
    });
  });
  return new Promise((resolve) =>
    st.server.listen(0, "127.0.0.1", () => {
      st.port = (st.server.address() as AddressInfo).port;
      resolve(st);
    }),
  );
}

let smtp: FakeSmtp;
let imap: FakeImap;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["MAIL_SMTP_HOST", "MAIL_SMTP_PORT", "MAIL_SMTP_TLS", "MAIL_USER", "MAIL_PASSWORD", "MAIL_IMAP_HOST", "MAIL_IMAP_PORT", "MAIL_IMAP_TLS", "MAIL_IMAP"];

beforeAll(async () => {
  smtp = await fakeSmtp();
  imap = await fakeImap();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterAll(() => {
  smtp.server.close();
  imap.server.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterEach(() => {
  _resetResendGuardForTest();
  smtp.messages = [];
  smtp.rejectRcpt = false;
  smtp.dropAfterData = false;
  imap.sentIds.clear();
});

function configure(): void {
  process.env.MAIL_SMTP_HOST = "127.0.0.1";
  process.env.MAIL_SMTP_PORT = String(smtp.port);
  process.env.MAIL_SMTP_TLS = "none";
  process.env.MAIL_USER = "anton@example.test";
  process.env.MAIL_PASSWORD = "app-password";
  process.env.MAIL_IMAP_HOST = "127.0.0.1";
  process.env.MAIL_IMAP_PORT = String(imap.port);
  process.env.MAIL_IMAP_TLS = "none";
  process.env.MAIL_IMAP = "1";
}
function unconfigure(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

let userN = 0;
function ctx(confirmApproved = true): ToolContext & { confirm: ReturnType<typeof vi.fn> } {
  userN += 1;
  const confirm = vi.fn(async () => ({ approved: confirmApproved, outcome: confirmApproved ? "approved" : "denied" }));
  return { session: { sendAction: vi.fn() }, userId: `mail-u${userN}`, confirm } as unknown as ToolContext & { confirm: ReturnType<typeof vi.fn> };
}
const mail = { to: "petrov@example.test", subject: "Согласен", body: "Добрый день, согласен с условиями. Антон" };

describe("mail_send — исходящая почта с гейтами §14 и честным исходом", () => {
  it("не настроено → честная ошибка с тем, что завести; SMTP не трогается", async () => {
    unconfigure();
    const r = await dispatchTool("mail_send", mail, ctx());
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/MAIL_SMTP_HOST/u);
    expect(String(r.content)).toMatch(/пароля приложения/u);
    expect(smtp.messages).toHaveLength(0);
  });

  it("настроено: подтверждение адресата → SMTP принял (250) → sent:true; письмо реально с Message-ID/Subject/base64-телом; IMAP нашёл копию", async () => {
    configure();
    const c = ctx(true);
    // фейковый IMAP «сохраняет» всё, что пришло в SMTP: подхватываем Message-ID из письма
    const before = smtp.messages.length;
    const p = dispatchTool("mail_send", mail, c);
    // как только SMTP получит письмо, «положим» его в Отправленные до IMAP-сверки
    const tick = setInterval(() => {
      const m = smtp.messages[before];
      if (m) {
        const id = /Message-ID: (<[^>]+>)/u.exec(m)?.[1];
        if (id) imap.sentIds.add(id);
        clearInterval(tick);
      }
    }, 5);
    const r = await p;
    clearInterval(tick);
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(String(c.confirm.mock.calls[0]?.[0])).toContain("petrov@example.test");
    expect(r.isError).toBe(false);
    expect(r.sent).toBe(true);
    expect(String(r.content)).toMatch(/сервер принял/u);
    expect(String(r.content)).toMatch(/Копия в «Sent» есть/u);
    const raw = smtp.messages[0]!;
    expect(raw).toMatch(/^Message-ID: <.+@example\.test>/mu);
    expect(raw).toMatch(/^To: petrov@example\.test/mu);
    expect(raw).toMatch(/^Subject: =\?UTF-8\?B\?/mu); // кириллица в теме — RFC 2047
    expect(Buffer.from(raw.split("\r\n\r\n")[1]!.replace(/\r\n/gu, ""), "base64").toString("utf8")).toContain("согласен с условиями");
  });

  it("владелец отказал → declined, письмо НЕ ушло", async () => {
    configure();
    const r = await dispatchTool("mail_send", mail, ctx(false));
    expect(r.declined).toBe(true);
    expect(r.sent).toBeUndefined();
    expect(smtp.messages).toHaveLength(0);
  });

  it("сервер отверг адресата (550 на RCPT) → ошибка «НЕ отправлено», не ложный успех", async () => {
    configure();
    smtp.rejectRcpt = true;
    const r = await dispatchTool("mail_send", mail, ctx());
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/НЕ отправлено/u);
    expect(String(r.content)).toMatch(/550/u);
  });

  it("обрыв ПОСЛЕ отправки тела и нет копии в «Отправленных» → «не знаю, ушло ли», uncertain, sent не ставится", async () => {
    configure();
    smtp.dropAfterData = true;
    const r = await dispatchTool("mail_send", mail, ctx());
    expect(r.isError).toBe(false);
    expect(r.uncertain).toBe(true);
    expect(r.sent).toBeUndefined();
    expect(String(r.content)).toMatch(/Не знаю, ушло ли/u);
  });

  it("повтор того же письма тому же адресату в окне → не уходит без resend:true; с resend — спрашивает снова", async () => {
    configure();
    const c = ctx(true);
    await dispatchTool("mail_send", mail, c);
    // cadence-гард (minGapMs 3 с к одному адресату) стоит ПЕРЕД дедупом, как у telegram_send — ждём его окно,
    // чтобы проверить именно дедуп/ресенд, а не «cadence-лимит».
    await new Promise((r) => setTimeout(r, 3_100));
    const again = await dispatchTool("mail_send", mail, c);
    expect(String(again.content)).toMatch(/Уже отправлял/u);
    expect(smtp.messages).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 3_100));
    const forced = await dispatchTool("mail_send", { ...mail, resend: true }, c);
    expect(c.confirm).toHaveBeenCalledTimes(2); // адресат уже одобрен, но повтор спрашивает всегда
    expect(forced.sent).toBe(true);
    expect(smtp.messages).toHaveLength(2);
  }, 20_000); // два cadence-окна по 3 с

  it("не e-mail в to → ошибка без похода в SMTP", async () => {
    configure();
    const r = await dispatchTool("mail_send", { ...mail, to: "Петров" }, ctx());
    expect(r.isError).toBe(true);
    expect(smtp.messages).toHaveLength(0);
  });
});
