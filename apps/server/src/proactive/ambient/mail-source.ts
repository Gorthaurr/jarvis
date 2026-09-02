/**
 * Источник ambient #4: ПОЧТА (волна D, D-5 — «Сэр, вам письмо от бухгалтерии»).
 *
 * Как и календарь: БЕЗ OAuth и регистраций — читаем УЖЕ ОТКРЫТУЮ вкладку почты (Gmail/Яндекс/Mail.ru/
 * Outlook) через расширение, в сессии владельца. Нет вкладки → молчим (он и так видит бейдж во вкладке).
 * Берём ТОЛЬКО список (отправитель/тема) — тело письма в промпт не тянем: ambient оно не нужно, а это
 * лишний канал prompt-инъекции.
 *
 * ЧЕСТНОСТЬ: «писем нет», «вкладки нет», «страница пуста» и «разметку не узнал» — разные исходы;
 * последние два пишут durable-деградацию, чтобы молчание не выглядело как пустой ящик.
 * САЛИЕНТНОСТЬ: почта — фон, не срочность (0.6): важное владелец и так увидит, а будить на каждую
 * рассылку нельзя. Отправители из `importantSenders` поднимаются выше.
 */
import { type Logger, createLogger, envInt } from "@jarvis/shared";
import { metrics } from "../../obs/metrics.js";
import type { AmbientSignal, AmbientSource } from "./signal.js";

const log: Logger = createLogger("ambient:mail");

/** Одно непрочитанное письмо (из DOM списка). */
export interface MailItem {
  from: string;
  subject: string;
}

/** Ответ расширения на mail.read. */
export interface MailReadResult {
  ok?: boolean;
  noTab?: boolean;
  blank?: boolean;
  mail?: MailItem[];
  /** Узнали ли вёрстку списка. false → `mail` пуст не потому, что писем нет, а потому что не разобрали. */
  recognized?: boolean;
  /** Читали ли ВХОДЯЩИЕ. false → пустой список ничего не говорит о новых письмах (открыта другая папка). */
  inbox?: boolean;
  /** Всего непрочитанных на странице (может быть больше отданных в `mail` — см. `truncated`). */
  unreadTotal?: number;
  /** Убедились ли, что понимаем пометку «непрочитано» этого вендора. false → пустой список НЕ доказывает,
   *  что писем нет (селекторы строк и маркера — разные семейства). */
  markerConfident?: boolean;
  /** Список обрезан капом — длина `mail` НЕ равна числу писем. */
  truncated?: boolean;
  /** Сырой текст — ТОЛЬКО когда список распознать не удалось (см. `textIsWholePage`). */
  text?: string;
  /** Честный флаг: `text` — это ВСЯ страница (может содержать открытое письмо), а не список. */
  textIsWholePage?: boolean;
  host?: string;
  error?: string;
}

/** Минимальный контракт ридера (ExtensionBridge реализует; в тестах — мок). */
export interface MailReader {
  mailRead(): Promise<unknown>;
}

export interface MailSourceOpts {
  now?: () => number;
  enabled?: () => boolean;
  /** «Важные» отправители (подстрока, без регистра) — выше порога салиентности. */
  importantSenders?: () => string[];
  /** Сколько писем максимум объявлять за один тик (остальные — фоном, без озвучки). */
  maxPerTick?: number;
}

/** Короткий стабильный хеш (ключ дедупа письма). */
function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Похоже ли на массовую рассылку — такие не будим озвучкой (ниже порога салиентности). */
export function looksLikeBulk(item: MailItem): boolean {
  const s = `${item.from} ${item.subject}`.toLowerCase();
  return /(no-?reply|noreply|newsletter|рассылк|подписк|промо|скидк|акци|distribution|mailer|notification|уведомлен)/.test(s);
}

/** СТАТУСНЫЙ глагол доставки/отправления — «что-то произошло с моей посылкой», а не «купите». */
const DELIVERY_STATUS_RE =
  /(доставлен|доставлено|доставили|вручен|выдан|получен|отправлен|отправлено|отправили|передан курьер|курьер (?:уже |в пути|приедет|подъедет)|в пути|прибыл|прибыло|поступил|готов[оа]? к (?:выдаче|получению)|можно забрать|ожидает в пункте|shipped|delivered|out for delivery|arriv(?:ed|ing)|dispatched|picked up)/;

/**
 * ИДЕНТИФИКАТОР конкретной посылки/заказа: «заказ №12345», «order #98765».
 *
 * 🔴 Сигил (№/#/nº/номер) ОБЯЗАТЕЛЕН (адверс-ревью 2026-09-01): без него «Скидка на заказ 3000
 * рублей» читалось как номер заказа и промо уезжало в озвучку. У настоящего письма о заказе номер
 * почти всегда с сигилом, а без сигила его подхватит связка «статус + объект» ниже.
 */
const ORDER_ID_RE = /(?:заказ\w*|отправлени\w*|посылк\w*|order|shipment)\s*(?:№|#|nº|no\.?|номер)\s*\d{3,}/;
const TRACK_ID_RE = /(?:тре[кй]\w*|трек-?номер|track(?:ing)?(?:[ -]?(?:number|no|code|id))?)\s*[№#:]?\s*[a-z0-9]{6,}|\b[a-z]{2}\d{9}[a-z]{2}\b/;

/** ОБЪЕКТ доставки: о ЧЁМ статус. Без него статусный глагол — обычная рекламная риторика. */
const PARCEL_OBJECT_RE =
  /(заказ|посылк|отправлени|доставк|бандерол|груз|товар|курьер|order|parcel|shipment|package|delivery|трек)/;

/**
 * ПЕРСОНАЛЬНОЕ письмо о судьбе заказа/посылки — по СМЫСЛУ, а не по адресу отправителя.
 *
 * 🔴 Живой дефект: «Ваш заказ доставлен» приходит с no-reply@ozon.ru и словом «Уведомление» в теме —
 * `looksLikeBulk` роняло его до 0.25 при пороге озвучки 0.5. То есть ЕДИНСТВЕННЫЙ канал, способный
 * сообщить о доставке без открытой вкладки, давил ровно те письма, ради которых он и нужен.
 * Разрез именно по смыслу (статусный глагол ЛИБО номер заказа/трека), а не отменой bulk: «Бесплатная
 * доставка от 1000 ₽» и «Скидка на доставку» остаются внизу — там нет ни статуса, ни идентификатора.
 */
export function looksLikeTransactional(item: MailItem): boolean {
  const s = `${item.from} ${item.subject}`.toLowerCase();
  // Статусный глагол САМ ПО СЕБЕ ничего не разрезает (адверс-ревью 2026-09-01): «Заявка отправлена»,
  // «игры уже в пути», «комментарий получен», «Новый сезон прибыл!» — это рассылки, и они уезжали в
  // озвучку 0.6. Нужен ещё ОБЪЕКТ доставки — тогда речь о судьбе посылки, а не о распродаже.
  return (DELIVERY_STATUS_RE.test(s) && PARCEL_OBJECT_RE.test(s)) || ORDER_ID_RE.test(s) || TRACK_ID_RE.test(s);
}

/** Чистая функция: письмо → ambient-сигнал (или null, если сказать нечего). */
export function mailSignal(item: MailItem, userId: string, now: number, important: string[]): AmbientSignal | null {
  const from = (item.from || "").trim();
  const subject = (item.subject || "").trim();
  if (!from && !subject) return null;
  const isImportant = important.some((c) => c && `${from} ${subject}`.toLowerCase().includes(c.toLowerCase()));
  // Рассылка — ниже дефолтного порога 0.5 (движок её не озвучит); важный отправитель перебивает.
  // Письмо о СУДЬБЕ ЗАКАЗА (доставлен/отправлен/трек) тоже перебивает bulk: оно приходит с того же
  // no-reply, что и промо, но это персональное событие владельца — ради него источник и существует.
  const salience = isImportant ? 0.85 : looksLikeTransactional({ from, subject }) ? 0.6 : looksLikeBulk({ from, subject }) ? 0.25 : 0.6;
  const who = from || "неизвестный отправитель";
  const what = subject ? ` — «${subject.slice(0, 80)}»` : "";
  return {
    sourceId: "mail",
    userId,
    key: `${shortHash(from.toLowerCase())}:${shortHash(subject.toLowerCase())}`,
    title: `Сэр, вам письмо от ${who}${what}.`,
    detail: subject || undefined,
    salience,
    ts: now,
  };
}

/** Собрать ambient-источник почты поверх ридера расширения. */
export function createMailSource(reader: MailReader, ownerUserId: string, opts: MailSourceOpts = {}): AmbientSource {
  const now = opts.now ?? Date.now;
  const enabled = opts.enabled ?? (() => true);
  const important = opts.importantSenders ?? (() => []);
  const maxPerTick = opts.maxPerTick ?? envInt("JARVIS_MAIL_MAX_PER_TICK", 3);
  let lastDegradeAt = 0;
  const noteDegradation = (kind: string, meta: Record<string, unknown>): void => {
    const t = now();
    if (t - lastDegradeAt < 30 * 60_000) return;
    lastDegradeAt = t;
    try {
      metrics.recordDegradation(kind, meta);
    } catch {
      /* наблюдаемость не должна ронять источник */
    }
    log.warn("почту прочитать не удалось", { kind, ...meta });
  };
  return {
    id: "mail",
    label: "Почта (открытая вкладка)",
    enabled,
    poll: async () => {
      let res: MailReadResult;
      try {
        res = ((await reader.mailRead()) ?? {}) as MailReadResult;
      } catch (e) {
        log.debug("mail.read недоступен (расширение/вкладка) — пропуск", e instanceof Error ? e.message : String(e));
        return [];
      }
      if (res.noTab) return [];
      if (res.blank || res.ok === false) {
        noteDegradation("mail_unreadable", { reason: res.blank ? "blank" : (res.error ?? "error").slice(0, 120) });
        return [];
      }
      // Вёрстку не узнали — это НЕ «писем нет»: пишем деградацию (докстринг модуля это и обещает),
      // иначе новая вёрстка Gmail молча выключала бы D-5 навсегда.
      if (res.recognized === false) {
        noteDegradation("mail_layout_unknown", { host: res.host });
        return [];
      }
      // Список разобран, но пометку «непрочитано» этого вендора мы не подтвердили → пустота НИЧЕГО не
      // доказывает. Молчим (будить владельца нечем), но пишем деградацию: иначе слепота D-5 была бы
      // невидимой в метриках, как это уже было с `mail_layout_unknown` (контроль-10).
      if (res.markerConfident === false && (!Array.isArray(res.mail) || res.mail.length === 0)) {
        noteDegradation("mail_unread_marker_unknown", { host: res.host });
        return [];
      }
      // Насчитали непрочитанные, но полей из них не вытащили (контроль-11): объявлять нечего — но это
      // слепота, а не пустой ящик, и она обязана быть видимой в метриках.
      if (typeof res.unreadTotal === "number" && res.unreadTotal > 0 && (!Array.isArray(res.mail) || res.mail.length === 0)) {
        noteDegradation("mail_rows_unparsed", { host: res.host, unread: res.unreadTotal });
        return [];
      }
      if (!Array.isArray(res.mail)) return [];
      const t = now();
      const imp = important();
      // Кап НЕ по позиции в списке (контроль-6): раньше первые N строк съедали бюджет тика НАВСЕГДА —
      // три рассылки сверху (они даже не звучат, salience ниже порога) блокировали письмо бухгалтерии
      // четвёртым, и оно не объявлялось НИКОГДА. Отдаём ВСЕ распознанные письма: движок сам дедуплицирует
      // по ключу, отсекает по салиентности и ограничивает число озвучек за тик, а неотданное вернётся
      // следующим тиком (ничем не помеченное). maxPerTick остаётся лишь верхней страховкой на размер.
      const out: AmbientSignal[] = [];
      for (const item of res.mail.slice(0, Math.max(maxPerTick, 25))) {
        const s = mailSignal(item, ownerUserId, t, imp);
        if (s) out.push(s);
      }
      return out;
    },
  };
}
