/**
 * Рефлекс-бэкстоп ОБЯЗАТЕЛЬСТВ (волна D «мажордом», 2026-07-29) — зеркало memory-reflect, но для
 * дел со сроком, а не для фактов о владельце.
 *
 * Диагноз аудита: сказанное вслух «завтра надо позвонить маме», «в пятницу платёж по кредиту» НЕ
 * превращалось ни во что — владелец обязан был отдельно продиктовать команду «поставь напоминание».
 * Настоящий мажордом слышит намерение и берёт его на себя.
 *
 * Механика: грубый префильтр-маркер (LLM зовётся редко) → ОДИН вызов на дешёвом тире с узким набором
 * [set_reminder] и строгим промптом («чаще всего обязательства НЕТ») → сервер сам считает время.
 * Fire-and-forget: голосовой ход не ждёт.
 *
 * ЧЕСТНОСТЬ (главное отличие от памяти): напоминание — ВИДИМЫЙ побочный эффект, который потом
 * заговорит сам. Поэтому Джарвис ОБЯЗАН сказать, что взял его на себя (`onCreated` → короткая
 * реплика в очередь озвучки). Молча ставить будильники владельцу нельзя.
 *
 * Анти-спам: (1) маркер, (2) суточный кап JARVIS_COMMITMENT_REFLECT_CAP (деф 6), (3) идемпотентность
 * ReminderService (тот же текст+время в окне = один), (4) только явно будущее время.
 * Выключатель: JARVIS_COMMITMENT_REFLECT=0.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { TOOLS_BY_NAME } from "@jarvis/tools";
import { autonomyFreeze } from "../../autonomy/freeze.js";
import { autonomyThrottle } from "../../autonomy/throttle.js";
import type { ILlmProvider } from "../../integrations/llm.js";
import type { SpendGuard } from "../../billing/index.js";
import { costUsd } from "../../obs/pricing.js";
import { describeRepeat, describeWhen, parseRepeat, resolveFireAt } from "../../proactive/reminders/reminder.js";
import type { ReminderService } from "../../proactive/reminders/service.js";

const log: Logger = createLogger("commitment-reflect");

/**
 * Маркеры ОБЯЗАТЕЛЬСТВА: «надо/нужно/должен + глагол», «не забыть», «завтра/в пятницу … сделать».
 * Узко и намеренно: команда Джарвису («открой», «напомни») сюда не попадает — её обслуживает обычная
 * петля; ловим именно РАЗМЫШЛЕНИЕ ВСЛУХ о собственном деле.
 */
const COMMITMENT_MARKER_RE =
  // После «надо/нужно» допускаем и ЧИСЛО («нужно 5 августа продлить») — не только слово.
  // Негативный lookahead «напомн» отсекает КОМАНДУ Джарвису («надо напомнить мне…»), её выполняет петля.
  /(?:^|[\s,])(?:(?:мне\s+)?(?:надо|нужно|нада)\s+(?!напомн)[\p{L}\d]+|я\s+должен|я\s+должна|не\s+забыть|планирую|собираюсь)(?=[\s,.!?]|$)/iu;

/** Маркер СРОКА — без него «надо сходить в зал» это не дело с датой, а намерение вообще. */
const WHEN_MARKER_RE =
  /(?:^|[\s,])(?:сегодня|завтра|послезавтра|вечером|утром|днём|днем|ночью|в\s+(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)|через\s+\p{L}*\s*(?:минут|час|день|дня|дней|недел)\p{L}*|\d{1,2}[:.]\d{2}|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря))(?=[\s,.!?]|$)/iu;

/** Похоже ли на обязательство СО СРОКОМ (дешёвый префильтр перед LLM). Чистая функция. */
export function hasCommitmentMarker(text: string): boolean {
  return COMMITMENT_MARKER_RE.test(text) && WHEN_MARKER_RE.test(text);
}

const SYSTEM_PROMPT =
  "Ты — модуль планирования голосового ассистента (сейчас {NOW}, часовой пояс владельца). " +
  "Дана одна реплика владельца (сырой STT-текст). Если в ней он проговаривает СВОЁ ДЕЛО С КОНКРЕТНЫМ " +
  "СРОКОМ («завтра надо позвонить маме», «в пятницу платёж») — вызови set_reminder ОДИН раз: " +
  "at — абсолютное локальное время ISO-8601 в будущем (для «завтра» без времени бери 10:00), " +
  "text — короткая фраза ОТ ЛИЦА ДЖАРВИСА, которую он произнесёт в тот момент («Напоминаю: позвонить маме»). " +
  "НЕ ставь напоминание, если: это просьба к тебе (её и так выполнят), срок неясен, дело уже сделано, " +
  "это чужое дело, вопрос, игровой трёп или STT-шум. Чаще всего обязательства НЕТ — тогда не вызывай " +
  "инструмент и ответь пустой строкой.";

/** Суточный кап рефлексий per-user (календарный день, сброс на смене даты). */
const dayCounters = new Map<string, { day: string; count: number }>();

function underDailyCap(userId: string): boolean {
  const cap = (() => {
    const n = Number.parseInt(process.env.JARVIS_COMMITMENT_REFLECT_CAP ?? "", 10);
    return Number.isFinite(n) && n >= 0 ? n : 6;
  })();
  if (cap === 0) return false;
  const today = new Date().toISOString().slice(0, 10);
  const c = dayCounters.get(userId);
  if (!c || c.day !== today) {
    dayCounters.set(userId, { day: today, count: 0 });
    return true;
  }
  return c.count < cap;
}

function bumpDailyCap(userId: string): void {
  const c = dayCounters.get(userId);
  if (c) c.count += 1;
}

export interface CommitmentReflectArgs {
  llm: ILlmProvider;
  /** Дешёвый тир: извлечение срока — механика, не рассуждение. */
  model: string;
  reminders: ReminderService;
  sessionId: string;
  userId: string;
  /** Реплика владельца (clean, после cleanDisfluency). */
  utterance: string;
  /** Сказать владельцу, что дело взято на себя (обязательно — молчаливых будильников не ставим). */
  onCreated?: (line: string) => void;
  spend?: SpendGuard;
}

/**
 * Рефлексия одной реплики → 0..1 напоминание. Звать fire-and-forget ТОЛЬКО после hasCommitmentMarker.
 * Ошибки глотаются (бэкстоп не роняет ход).
 */
export async function reflectCommitmentFromUtterance(args: CommitmentReflectArgs): Promise<void> {
  if (process.env.JARVIS_COMMITMENT_REFLECT === "0") return;
  // Волна E: killswitch — ранним гейтом; throttle — ПОСЛЕ underDailyCap и ДО bumpDailyCap (контроль-
  // ревью: фантомные штампы сверх суточного капа; и отказ предохранителя не жжёт суточный кап).
  if (autonomyFreeze().isFrozen()) return;
  if (!underDailyCap(args.userId)) return;
  if (!autonomyThrottle().tryAcquire("commitment-reflect")) return;
  bumpDailyCap(args.userId); // считаем ВЫЗОВ, не успех — кап ограничивает расход LLM
  const schema = TOOLS_BY_NAME.set_reminder;
  if (!schema) return;
  const taskId = `commitment-reflect:${args.userId}:${Date.now()}`;
  if (args.spend && !args.spend.check(taskId, 0.01, 500).allowed) return;
  try {
    const now = Date.now();
    const resp = await args.llm.complete({
      tier: "sonnet",
      model: args.model,
      systemStatic: SYSTEM_PROMPT.replace("{NOW}", new Date(now).toLocaleString("ru-RU")),
      messages: [{ role: "user", content: args.utterance }],
      tools: [schema],
    });
    args.spend?.recordStep(taskId);
    args.spend?.recordUsage(taskId, resp.usage.inputTokens + resp.usage.outputTokens, costUsd(args.model, resp.usage));
    const tu = resp.toolUses.find((t) => t.name === "set_reminder");
    if (!tu) return; // обязательства нет — штатный (частый) исход
    const input = tu.input as Record<string, unknown>;
    const text = String(input.text ?? "").trim();
    if (!text) return;
    const when = resolveFireAt(
      { delaySeconds: input.delay_seconds as number | undefined, at: input.at as string | undefined },
      now,
    );
    if ("error" in when) {
      log.debug("рефлекс обязательства: время не разобрано — пропускаю", { error: when.error });
      return;
    }
    // Тот же гард sentinel-значений, что в хендлере (контроль волны D: пропущенный sibling call-site —
    // Number(null)=0 глушил РИТМ, и «каждый день в 21:00» становилось разовым напоминанием МОЛЧА).
    const rs = input.repeat_seconds;
    const repRaw = rs === undefined || rs === null || rs === "" || rs === 0 ? input.repeat : Number(rs);
    const rep = parseRepeat(repRaw);
    // РИТМ НЕ РАЗОБРАН → НИЧЕГО НЕ СТАВИМ (контроль-2 волны D): раньше ошибка молча падала в undefined,
    // рефлекс ставил ОДНОРАЗОВОЕ и вслух подтверждал «поставил напоминание …» — владелец слышал, что дело
    // взято с повтором, а сработало бы однажды. Рефлекс — бэкстоп: пропустить тише, чем соврать
    // (основная петля эту же реплику обрабатывает своим путём и вернёт модели ЧЕСТНУЮ ошибку разбора).
    if ("error" in rep) {
      log.info("рефлекс обязательства: ритм повтора не разобран — напоминание не ставлю", { error: rep.error });
      return;
    }
    const repeat = rep.repeat;
    const r = args.reminders.add({
      sessionId: args.sessionId,
      userId: args.userId,
      text,
      fireAt: when.fireAt,
      repeat,
    });
    // Дедуп вернул СУЩЕСТВУЮЩУЮ запись (основная петля уже поставила это же дело) — молчим: второе
    // подтверждение об одном напоминании и анонс формулировки, которой в сторе нет, — та же ложь,
    // что «поставил», когда не ставил (ревью волны D).
    if (r.created === false) {
      log.info("рефлекс обязательства: дело уже запланировано — второе подтверждение не произносим", { id: r.id });
      return;
    }
    const rhythm = describeRepeat(r.repeat);
    log.info("рефлекс обязательства: напоминание поставлено из реплики", {
      id: r.id,
      when: describeWhen(r.fireAt, now),
      preview: r.text.slice(0, 60),
    });
    // ЧЕСТНОСТЬ: владелец должен знать, что теперь это «висит» на Джарвисе. Текст — ИЗ ЗАПИСИ (r.text),
    // а не из локальной переменной: озвучиваем ровно то, что реально прозвучит в назначенный момент.
    args.onCreated?.(`Поставил напоминание ${describeWhen(r.fireAt, now)}${rhythm ? `, ${rhythm}` : ""}: ${r.text}`);
  } catch (e) {
    log.debug("рефлекс обязательства пропущен", e instanceof Error ? e.message : String(e));
  } finally {
    args.spend?.finishTask(taskId);
  }
}
