/**
 * Хендлер КАЛЕНДАРЯ (волна D, D-4) — «какие у меня встречи?» БЕЗ OAuth и регистраций.
 *
 * Источник истины — залогиненная вкладка владельца, читаемая расширением. Разбор в моменты времени
 * делает чистая `parseCalendarChips`, но мы ВСЕГДА отдаём и сырой текст страницы: если разметка
 * незнакома (другой вендор/новая вёрстка), модель прочитает его сама — это дешевле и честнее, чем
 * молчать «встреч нет». Текст страницы — ВНЕШНИЙ, поэтому идёт в <untrusted_content> (M11).
 *
 * ЧЕСТНОСТЬ: «календарь не открыт» и «выгруженная вкладка» — отдельные исходы, а не «встреч нет».
 */
import { parseCalendarChips } from "../../../proactive/ambient/calendar-parse.js";
import type { CalendarReadResult } from "../../../proactive/ambient/calendar-source.js";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { err, ok, untrusted } from "../dispatch-util.js";

function fmtEventTime(ts: number, now: number): string {
  const d = new Date(ts);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = new Date(now);
  const sameDay = d.getFullYear() === day.getFullYear() && d.getMonth() === day.getMonth() && d.getDate() === day.getDate();
  if (sameDay) return `сегодня ${hhmm}`;
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")} ${hhmm}`;
}

export async function calendarRead(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.ext?.calendarRead) return err("Календарь читается через расширение браузера, а оно сейчас не подключено.");
  const open = input.open === true;
  let res: CalendarReadResult;
  try {
    res = ((await ctx.ext.calendarRead(open)) ?? {}) as CalendarReadResult;
  } catch (e) {
    return err(`Не смог прочитать календарь: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.noTab) {
    return err(
      "Вкладка календаря не открыта, поэтому встреч я не вижу (это НЕ значит, что их нет). " +
        "Повтори с open=true — открою фоновую вкладку календаря и прочитаю.",
    );
  }
  if (res.blank) return err("Вкладка календаря выгружена браузером и отдала пустую страницу — прочитать не удалось.");
  if (res.ok === false) return err(`Не смог прочитать календарь: ${res.error ?? "неизвестная ошибка"}`);

  const now = Date.now();
  const chips = Array.isArray(res.events) ? res.events.length : 0;
  const parsed = parseCalendarChips(Array.isArray(res.events) ? res.events : [], now);
  // «Чипов ноль» и «чипы есть, но не разобрались» — РАЗНЫЕ вещи, и путать их нельзя (тот же класс, что
  // «писем нет» vs «вёрстку не узнал»): в первом случае встреч, скорее всего, правда нет, во втором
  // разметка незнакома. Живой прогон в Chrome: пустой день даёт chips=0 и текст «Нет мероприятий» —
  // говорить при этом «разобрать не удалось» значит валить на себя чужую вину и путать модель.
  // ЧАСТИЧНЫЙ РАЗБОР — НЕ ПОЛНЫЙ СПИСОК (контроль-11): часть чипов могла не разобраться, и выдавать
  // остаток за «все встречи» — та же ложная полнота, что «показаны первые N из M» у почты.
  const partial =
    parsed.events.length > 0 && parsed.unparsed > 0
      ? `\n(ещё ${parsed.unparsed} элемент(ов) разобрать не удалось — сверься с текстом страницы ниже, ` +
        "прежде чем говорить, что это ВСЕ встречи)"
      : "";
  const head =
    parsed.events.length > 0
      ? `События календаря (${res.host ?? "вкладка"}):\n${parsed.events
          .map((e) => `• ${fmtEventTime(e.startAt, now)}${e.allDay ? " (весь день)" : ""} — ${e.title}`)
          .join("\n")}${partial}`
      : chips === 0
        ? "Ни одного элемента-события на странице не найдено — похоже, встреч нет. Сверься с текстом страницы ниже, прежде чем утверждать."
        : `Элементы событий на странице есть (${chips}), но разобрать из них дату/время не удалось — ` +
          "разметка незнакомая. Прочитай текст страницы ниже сам.";
  const body = res.text ? `${head}\n\n--- текст страницы ---\n${res.text}` : head;
  return untrusted("calendar-page", body);
}
