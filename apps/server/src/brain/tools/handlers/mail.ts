/**
 * Хендлер ПОЧТЫ (волна D, D-5) — «что мне пришло?» БЕЗ OAuth и регистраций.
 *
 * Источник — залогиненная вкладка владельца через расширение. Отдаём разобранный список
 * (отправитель/тема) И сырой текст страницы: незнакомая вёрстка не должна оборачиваться молчанием —
 * модель прочитает текст сама. Текст ВНЕШНИЙ → <untrusted_content> (M11): письма — классический
 * канал prompt-инъекции, инструкции оттуда исполнять нельзя.
 *
 * ЧЕСТНОСТЬ: «почта не открыта» и «вкладка выгружена» — не «писем нет».
 */
import { metrics } from "../../../obs/metrics.js";
import type { MailReadResult } from "../../../proactive/ambient/mail-source.js";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { err, gateDeclined, ok, untrusted } from "../dispatch-util.js";
import { peerIdentityKeys } from "../../messaging/resend-guard.js";
import { idempotencyKey } from "../../messaging/outbound.js";
import { approveSend } from "../../consent.js";
import { type ImapConfig, imapFindMessage } from "../../../integrations/imap.js";
import { type MailMessage, type SmtpConfig, SmtpUncertainError, buildMessageId, smtpSend } from "../../../integrations/smtp.js";
import { cadence, confirmSendOnce, resendGuard, sendGateMessage, sendLock, sentKeys } from "./messaging.js";

export async function mailRead(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.ext?.mailRead) return err("Почта читается через расширение браузера, а оно сейчас не подключено.");
  const open = input.open === true;
  let res: MailReadResult;
  try {
    res = ((await ctx.ext.mailRead(open)) ?? {}) as MailReadResult;
  } catch (e) {
    return err(`Не смог прочитать почту: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.noTab) {
    return err(
      "Вкладка почты не открыта, поэтому писем я не вижу (это НЕ значит, что их нет). " +
        "Повтори с open=true — открою фоновую вкладку почты и прочитаю.",
    );
  }
  if (res.blank) return err("Вкладка почты выгружена браузером и отдала пустую страницу — прочитать не удалось.");
  if (res.ok === false) return err(`Не смог прочитать почту: ${res.error ?? "неизвестная ошибка"}`);

  const items = Array.isArray(res.mail) ? res.mail : [];
  // «Вёрстку узнали» — авторитетный признак расширения. Без него «непрочитанных нет» было НЕОТЛИЧИМО
  // от «список не разобрал»: пустой ящик (самый частый случай) уезжал в облако текстом всей страницы
  // вместе с ЛОЖНЫМ «разбор не удался» (контроль-4 волны D).
  if (res.recognized !== false) {
    if (items.length === 0) {
      // Пустой список — ответ на вопрос владельца ТОЛЬКО если читали ВХОДЯЩИЕ (контроль-6): открытые
      // «Отправленные»/«Промоакции» разбираются успешно и непрочитанных там нет по определению —
      // сказать по ним «писем нет» значит соврать при полном ящике.
      if (res.inbox === false) {
        return err(
          "Открыта не папка «Входящие», а другой раздел почты — непрочитанных там нет по определению. " +
            "Про входящие сказать нечего: попроси открыть входящие или повтори с open=true.",
        );
      }
      // СЧЁТ ЕСТЬ, А ПИСЕМ НЕТ (контроль-11): инжектор насчитал непрочитанные строки, но отправителя и
      // тему из них вытащить не смог. Это НЕ «писем нет» — это «вижу, но не прочитал». Признак
      // markerConfident такой случай не ловит, а МАСКИРУЕТ (unreadTotal>0 как раз включает уверенность).
      if (typeof res.unreadTotal === "number" && res.unreadTotal > 0) {
        try {
          metrics.recordDegradation("mail_rows_unparsed", { host: res.host, unread: res.unreadTotal });
        } catch {
          /* наблюдаемость не должна ронять ответ */
        }
        return untrusted(
          "mail-page",
          `Непрочитанных писем ${res.unreadTotal}, но отправителя и тему из них вытащить не удалось — ` +
            "вёрстка незнакомая. Скажи владельцу ЧИСЛО и что подробностей не видно; не утверждай, что писем нет.",
        );
      }
      // «Список разобрали» ещё не значит «умеем отличать непрочитанное» (контроль-10): это разные
      // семейства селекторов. Не убедились в маркере → отвечаем ЧЕСТНО-ОСТОРОЖНО, а не уверенно.
      if (res.markerConfident === false) {
        try {
          metrics.recordDegradation("mail_unread_marker_unknown", { host: res.host });
        } catch {
          /* наблюдаемость не должна ронять ответ */
        }
        return untrusted(
          "mail-page",
          "Непрочитанных в списке не вижу, НО пометку «непрочитано» на этом сайте я мог не распознать — " +
            "так и скажи владельцу (не утверждай, что писем нет).",
        );
      }
      return untrusted("mail-page", "Непрочитанных писем нет.");
    }
    const shown = `Непрочитанные письма (${res.host ?? "вкладка"}):\n${items
      .map((m) => `• от ${m.from || "неизвестно"}${m.subject ? ` — «${m.subject}»` : ""}`)
      .join("\n")}`;
    // ЧЕСТНОСТЬ СЧЁТА: список режется, поэтому его длина — НЕ число писем. Без этой строки модель,
    // пересчитав пункты, называла «двадцать пять писем» при 60 в ящике (контроль-6).
    const total = typeof res.unreadTotal === "number" ? res.unreadTotal : items.length;
    const tail =
      res.truncated === true || total > items.length
        ? `\n(показаны первые ${items.length} из ${total} — называй общее число, а не длину списка)`
        : "";
    return untrusted("mail-page", shown + tail);
  }
  // Вёрстку не узнали — это ДЕГРАДАЦИЯ, а не норма: без записи «почему D-5 слепа» разбор был бы
  // невозможен (живой прогон 2026-07-29: у владельца Mail.ru, прежние селекторы его не знали).
  try {
    metrics.recordDegradation("mail_layout_unknown", { host: res.host, via: "tool" });
  } catch {
    /* наблюдаемость не должна ронять ответ */
  }
  if (!res.text) return err("Вёрстку почты не узнал и текста страницы не получил — прочитать не удалось.");
  // Вёрстку не узнали → отдаём текст страницы, но ЧЕСТНО предупреждаем модель, что это ВСЯ страница
  // (там может быть открытое письмо целиком). Обещать «только список» и слать тело — обман и владельца,
  // и модели: пусть она знает, с чем имеет дело, и не пересказывает лишнего вслух.
  const warn =
    "Список писем распознать не удалось, поэтому ниже — ТЕКСТ ВСЕЙ СТРАНИЦЫ почты. Там может быть " +
    "открытое письмо целиком: назови владельцу только отправителей и темы, тело не пересказывай, если не просили.";
  return untrusted("mail-page", `${warn}\n\n--- текст страницы ---\n${res.text}`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// mail_send — исходящая почта (причина №3 USER_SCENARIOS_2026-09-02): калька telegramSendLocked с channel:"email",
// те же гейты §14 (подтверждение адресата один раз, cadence, идемпотентность, ресенд-гард) и честность исхода:
// sent:true ТОЛЬКО когда SMTP принял письмо (250); обрыв после тела → сверка IMAP по Message-ID, иначе uncertain.
// Конфигурация — ТОЛЬКО из .env (пароль приложения заводит владелец): MAIL_SMTP_HOST/PORT, MAIL_USER, MAIL_PASSWORD,
// опц. MAIL_FROM, MAIL_IMAP_HOST/PORT, MAIL_IMAP=0. Транспорт серверный (SMTP с этой же машины).
// ─────────────────────────────────────────────────────────────────────────────────────────────
export interface MailConfig {
  smtp: SmtpConfig;
  imap?: ImapConfig;
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/u;

function tlsMode(port: number, raw: string | undefined): SmtpConfig["tls"] {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "none" || v === "implicit" || v === "starttls") return v;
  return port === 465 ? "implicit" : "starttls";
}

/** Конфигурация из env (лениво: .env грузится после ESM-хойста импортов). null = не настроено. */
export function mailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig | null {
  const host = (env.MAIL_SMTP_HOST ?? "").trim();
  const user = (env.MAIL_USER ?? "").trim();
  const password = env.MAIL_PASSWORD ?? "";
  if (!host || !user || !password) return null;
  const port = Number.parseInt(env.MAIL_SMTP_PORT ?? "", 10) || 465;
  const smtp: SmtpConfig = { host, port, user, password, from: (env.MAIL_FROM ?? "").trim() || user, tls: tlsMode(port, env.MAIL_SMTP_TLS) };
  const imapHost = (env.MAIL_IMAP_HOST ?? "").trim() || host.replace(/^smtp\./iu, "imap.");
  const imapPort = Number.parseInt(env.MAIL_IMAP_PORT ?? "", 10) || 993;
  const imapTls = (env.MAIL_IMAP_TLS ?? "").trim().toLowerCase() === "none" ? "none" : "implicit";
  const imap: ImapConfig | undefined = (env.MAIL_IMAP ?? "1") === "0" ? undefined : { host: imapHost, port: imapPort, user, password, tls: imapTls };
  return { smtp, ...(imap ? { imap } : {}) };
}

export const MAIL_NOT_CONFIGURED =
  "Почта не настроена: отправка требует пароля приложения, который заводит владелец. В .env нужны MAIL_SMTP_HOST " +
  "(напр. smtp.yandex.ru / smtp.mail.ru / smtp.gmail.com), MAIL_SMTP_PORT (465), MAIL_USER (адрес), MAIL_PASSWORD " +
  "(пароль ПРИЛОЖЕНИЯ, не основной), опционально MAIL_FROM, MAIL_IMAP_HOST. Через code_run smtplib отправлять НЕЛЬЗЯ — " +
  "у него нет подтверждения владельца, анти-дубля и признака «ушло».";

export async function mailSend(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  return sendLock(ctx.userId).run(() => mailSendLocked(ctx, input));
}

async function mailSendLocked(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const toRaw = String(input.to ?? "").trim();
  const subject = String(input.subject ?? "").trim();
  const body = String(input.body ?? "").trim();
  const resend = input.resend === true;
  if (!toRaw || !subject || !body) return err("mail_send: нужны to, subject и body");
  const to = toRaw
    .split(/[,;]/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = to.filter((a) => !EMAIL_RE.test(a));
  if (bad.length) return err(`mail_send: это не e-mail адреса: ${bad.join(", ")} (нужен вид user@domain)`);
  const cfg = mailConfig();
  if (!cfg) return err(MAIL_NOT_CONFIGURED);

  const recipient = to.join(",").toLowerCase();
  const cad = cadence.check({ userId: ctx.userId, channel: "email", recipient, neverMessagedBefore: false });
  if (!cad.allowed) return err(`Не отправил письмо «${recipient}»: cadence-лимит (${cad.reason}).`);
  const text = `${subject}\n${body}`;
  const key = idempotencyKey({ userId: ctx.userId, channel: "email", recipient, body: text });
  const identityKeys = peerIdentityKeys({ names: to });
  const recent = resendGuard().check(ctx.userId, "email", identityKeys, text);
  const identicalHit = sentKeys.get(key) !== undefined || recent?.kind === "identical";
  const uncertainPrev = recent?.prev.uncertain === true && sentKeys.get(key) === undefined;
  const preview = `Кому: ${to.join(", ")}\nТема: ${subject}\n${body.slice(0, 160)}${body.length > 160 ? "…" : ""}`;
  let confirmedByResendGate = false;
  if (identicalHit || recent) {
    if (identicalHit && !resend) {
      if (uncertainPrev) {
        return ok(
          `Не знаю, ушло ли это письмо «${recipient}»: прошлая попытка оборвалась, а в «Отправленных» его не нашёл. ` +
            `Вслепую не повторяю — проверьте ящик; если письма нет, повторите mail_send с resend:true.`,
        );
      }
      return ok(`Уже отправлял «${recipient}» это же письмо недавно — повтор НЕ ушёл. Если владелец ЯВНО просит ещё раз — повтори с resend:true (уйдёт после подтверждения).`);
    }
    if (!ctx.confirm) return err(`Повторная отправка письма «${recipient}» требует подтверждения (§14), а канал подтверждения недоступен.`);
    const summary = uncertainPrev
      ? `Прошлая отправка «${recipient}» оборвалась, и я не смог проверить, дошло ли. Отправить ещё раз (может прийти дублем)?\n${preview}`
      : identicalHit
        ? `Повторная отправка письма (то же уже уходило недавно):\n${preview}`
        : `«${recipient}» недавно получал письмо «${recent!.prev.bodyPreview}». Отправить вдогонку ещё и это?\n${preview}`;
    const c = await ctx.confirm(summary, "send");
    if (!c.approved) return gateDeclined(sendGateMessage(c.outcome, "письмо", recipient, true), c.outcome);
    confirmedByResendGate = true;
    await approveSend(ctx.userId, "email", recipient);
  }
  if (!confirmedByResendGate) {
    const gate = await confirmSendOnce(ctx, "email", recipient, `Отправить письмо?\n${preview}`);
    if (!gate.approved) return gateDeclined(sendGateMessage(gate.outcome, "письмо", recipient), gate.outcome);
  }

  const msg: MailMessage = { to, subject, body, messageId: buildMessageId(cfg.smtp.from) };
  try {
    const r = await smtpSend(cfg.smtp, msg);
    sentKeys.set(key, true);
    cadence.record(ctx.userId, "email", recipient);
    resendGuard().record(ctx.userId, "email", identityKeys, text);
    const verified = await verifySent(cfg, msg.messageId);
    return {
      ...ok(`Отправлено «${to.join(", ")}»: сервер принял письмо (${r.response.slice(0, 60)}). ${verified}`),
      sent: true,
    };
  } catch (e) {
    if (e instanceof SmtpUncertainError) {
      // Тело ушло, ответа нет: единственный честный источник — «Отправленные».
      const check = await imapCheck(cfg, msg.messageId);
      if (check.found) {
        sentKeys.set(key, true);
        cadence.record(ctx.userId, "email", recipient);
        resendGuard().record(ctx.userId, "email", identityKeys, text);
        return { ...ok(`Отправлено «${to.join(", ")}»: соединение оборвалось после отправки, но письмо лежит в «${check.folder}» — ушло.`), sent: true };
      }
      resendGuard().record(ctx.userId, "email", identityKeys, text, { uncertain: true });
      return {
        ...ok(`Не знаю, ушло ли письмо «${recipient}»: соединение оборвалось после отправки тела, а в «Отправленных» его нет (${check.note}). Вслепую не повторяю: проверьте ящик; если письма нет — повторите с resend:true.`),
        uncertain: true,
      };
    }
    return err(`Письмо НЕ отправлено: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function imapCheck(cfg: MailConfig, messageId: string): Promise<{ found: boolean; folder?: string; note: string }> {
  if (!cfg.imap) return { found: false, note: "IMAP-сверка выключена (MAIL_IMAP=0)" };
  try {
    const r = await imapFindMessage(cfg.imap, messageId);
    if (r.found) return { found: true, folder: r.folder, note: "" };
    return { found: false, note: r.checkedFolders.length ? `проверил ${r.checkedFolders.join(", ")}` : "папку «Отправленные» не нашёл" };
  } catch (e) {
    return { found: false, note: `IMAP не ответил: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Вторая сверка после успешного SMTP — информационная (SMTP 250 уже факт), формулировка честная. */
async function verifySent(cfg: MailConfig, messageId: string): Promise<string> {
  const check = await imapCheck(cfg, messageId);
  if (check.found) return `Копия в «${check.folder}» есть.`;
  return `Копию в «Отправленных» не подтвердил (${check.note}) — у части провайдеров она появляется с задержкой или не сохраняется.`;
}
