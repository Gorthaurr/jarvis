/**
 * Честный «голос ошибки» (§ErrorVoice) — провал НИКОГДА не должен звучать как успех.
 *
 * Проблема (ревью 2026-06-18): когда ВСЕ инструменты раунда вернули ошибку, модель часто закрывает
 * ход коротким бодрым текстом, и терминал озвучивает его как «Готово» — пользователь слышит успех на
 * фактическом провале (`anyToolSucceeded` гасил лишь самообучение, не реплику). Это подрывает доверие
 * («Джарвис врёт, что сделал»). Здесь — детекция «пустого подтверждения» и честные фразы о провале.
 *
 * Принцип (из практики voice-агентов): тихий/ложный успех недопустим; провал проговаривается, по делу,
 * без морали и без боллерплейта «что-то пошло не так» на все случаи (фраза зависит от класса/контекста).
 */

/** Класс сбоя — для разной (не боллерплейтной) формулировки. */
export type FailureClass = "tool" | "model" | "timeout" | "limit" | "offline" | "unknown";

const SUCCESS_WORD = /^(готово|сделал[аои]?|сделано|есть|выполнено|выполнил[аи]?|принято|подтверждаю|ок|окей|ага)$/u;
const SUCCESS_VERB = /^(открыл|запустил|включил|выключил|закрыл|отправил|нашёл|нашел|создал|сохранил)[а-я]*$/u;

/**
 * Похоже ли финальное слово модели на ПУСТОЕ подтверждение успеха («Готово», «Открыл, сэр») —
 * то, что нельзя озвучивать, если на деле всё упало. Содержательный ответ (длинный/не-успех) — НЕ пустой.
 */
export function isHollowSuccess(text: string): boolean {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[!.…,;:]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  // Обращение/вежливость отбрасываем по словам (НЕ через \bсэр\b: \b в JS не знает кириллицу).
  const words = cleaned.split(" ").filter((w) => w && w !== "сэр" && w !== "пожалуйста");
  if (words.length === 0) return true;
  if (words.length > 3) return false; // содержательная реплика — доверяем модели
  return words.every((w) => SUCCESS_WORD.test(w) || SUCCESS_VERB.test(w));
}

// Абсурд/опасное/незаконное — тут «отказ» это ЛЕГИТИМНАЯ остроумная отбивка в характере (persona §132),
// а НЕ капитуляция перед выполнимой задачей. Нудж-на-попытку туда не лезет.
const GIVEUP_EXCLUDE = /ракет|взлом|пентагон|уничтож|бомб|оруж|незакон|навред|вред[уи]|убит|кибератак/u;
// Фразы-капитуляции о ВЫПОЛНИМОЙ задаче — то, что нельзя принимать как финал без единой попытки.
// Срабатывает ТОЛЬКО при нуле вызовов инструментов (toolTrajectory===0), поэтому честное «не нашёл файл
// ПОСЛЕ поиска» сюда не попадает (там traj>0). Широкий охват — чтобы любой текст-отказ без попытки ловился.
const GIVEUP_PHRASES =
  /не умею|пока не (умею|могу)|не могу(?!\s+не\b)|не смогу(?!\s+не\b)|не получ(ится|илось)|не в (моих силах|моей власти|состоянии)|не в состоянии|не поддерживается|не реализовано|не предусмотрено|нет (такой|подходящ\w*) (функции|команды|возможности|инструмента)|у меня нет (доступа|возможности|инструмента|такой|прав)|не имею (возможности|доступа)|не располагаю|боюсь,? не (смогу|умею|могу)|увы,? не (смогу|могу|умею)|к сожалению,? (я )?не (смогу|могу|умею)|это (вне моих|невозможно|за пределами)|вне моих (возможностей|сил)|недоступно|это не входит|только (мышью|вручную|руками)/u;

/**
 * Похоже ли, что модель СДАЛАСЬ перед выполнимой задачей текстом, не сделав ни одного хода инструментом
 * (§«не сдавайся»). Используется как бэкстоп: при таком ответе БЕЗ единого вызова инструмента петля
 * форсит ещё одну попытку (web_search/code_run). НЕ срабатывает на легитимной отбивке абсурда/опасного.
 */
export function looksLikeGiveUp(text: string): boolean {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return false;
  if (GIVEUP_EXCLUDE.test(cleaned)) return false; // опасное/абсурд — это не капитуляция, а характер
  return GIVEUP_PHRASES.test(cleaned);
}

/**
 * Честная реплика, когда задача провалилась незаметно (все инструменты пали, модель сказала «Готово»).
 * spokeAny=true — часть ответа уже прозвучала, поэтому не противоречим «совсем не вышло», а мягко
 * обозначаем, что до конца не довели.
 */
export function maskedFailureReply(spokeAny: boolean): string {
  return spokeAny
    ? "…но до конца довести не вышло, сэр — нужное действие не сработало."
    : "Не вышло, сэр — нужное действие не сработало. Скажите, что именно нужно, зайду иначе.";
}

// VERIFY-ПЕТЛЯ (анти-конфабуляция). Сверка глазами — читает реальное состояние страницы/экрана.
// Волна 2 (2.3/2.4): ui_snapshot (живое UIA-дерево окна) и screen_read_text (локальный OCR реальных
// пикселей) — полноценные ДЕШЁВЫЕ сверки: читают фактическое состояние, а не доверяют «ok» действия.
const VERIFY_TOOLS = new Set([
  "browser_read", "browser_inspect", "screen_capture", "web_read", "context_read",
  "ui_snapshot", "screen_read_text",
]);
// Нейтральные — не меняют наблюдаемый результат на экране (поиск/память/навыки/служебные).
const NEUTRAL_TOOLS = new Set([
  // Аудит ядра [8]: skill_execute УБРАН из нейтральных — реплей навыка РЕАЛЬНО мутирует GUI (клики/ввод).
  // Как neutral он не взводил anyMutateSucceeded → успешный реплей + «тихий финал» ловился masked-failure
  // и озвучивался ЛОЖНЫМ «Не вышло» (честность в обратную сторону). Теперь по умолчанию mutate (как
  // input_batch); в BLIND_MUTATE он НЕ входит (у навыка своя checkExpect-сверка) → нового verify-долга нет.
  "web_search", "web_fetch", "memory_write", "memory_search", "skill_save", "skill_list",
  "skill_promote", "tool_load", "tool_create", "browser_tabs", "set_reminder", "cancel_reminder", "list_reminders",
  "watch_create", "watch_cancel", "watch_list", // §долгие-задачи: durable-конфиг наблюдения, не меняет экран
  "obligation_add", "obligation_remove", "obligation_list", // §проактив-всё: durable-конфиг счетов, не меняет экран
  // H3 (ревью 2026-07-02): чисто ЧИТАЮЩИЕ инструменты — «посмотрел» ≠ «сделал дело». Дефолт mutate
  // взводил anyMutateSucceeded на первом же чтении → анти-капитуляция/masked-failure отключались:
  // «прочитал файл/котировку и сдался словами» или пустое «Готово» после одних чтений проходили успехом.
  "fs_read", "fs_list", "fs_search", "telegram_read", "knowledge_consult",
  "market_quote", "market_candles", "market_analyze", "market_backtest",
  "tinkoff_portfolio", "trade_winrate", "trade_predictions", "monitor_list",
  // Волна 1 (аудит 2026-07-10): ui_ground — ЧТЕНИЕ (найти элемент через UIA), не действие. Раньше
  // числился слепым mutate → успешный грундинг взводил verify-нудж («сверь глазами») и КАРАЛ дешёвый
  // UIA-путь лишним vision-раундом — модель закономерно предпочитала сразу screen_capture.
  "ui_ground",
  // Волна 2 (2.3/2.4): чтения нового дешёвого слоя. window_list — список окон; screen_probe — детектор
  // перемен (НЕ verify: хеш не доказывает исход — план §4.2); wait_for — ожидание (его met:true за
  // сверку зачитывает agent-петля по data.met, не статический класс — см. dispatch/observed).
  "window_list", "screen_probe", "wait_for",
]);

// H3: у MCP-инструментов (mcp__server__tool) эффект не известен заранее. Читающее ИМЯ (get/list/
// read/search/…) — нейтрально; прочее консервативно остаётся mutate (реальное дело внешним сервисом).
const READONLY_NAME_RE = /^(get|list|read|search|query|fetch|describe|show|stat|status|info|count|find|check)([_\-.]|$)/i;

/** Эффект инструмента для verify-петли: сверка глазами / меняющее действие / нейтральное. Чистая функция. */
export function toolEffect(name: string): "verify" | "mutate" | "neutral" {
  if (VERIFY_TOOLS.has(name)) return "verify";
  if (NEUTRAL_TOOLS.has(name)) return "neutral";
  if (name.startsWith("mcp__")) {
    const base = name.split("__").pop() ?? name;
    if (READONLY_NAME_RE.test(base)) return "neutral";
  }
  return "mutate"; // browser_open/act, web_open/act, input_*, app_*, fs_write/edit, office_*, system_*, code_run…
}

// СЛЕПЫЕ меняющие действия (P0.2): их ok-результат НЕ доказывает достижение цели в реальном мире.
// SendInput (input_*) не имеет обратной связи; browser_act/web_act/ui_invoke могут «нажать» в пустоту
// (регион/нет элемента/потерян фокус) и вернуть ok; app_focus (AppActivate) хрупкий. После такого
// действия перед «готово» ОБЯЗАТЕЛЬНА сверка глазами (browser_read/inspect/screen_capture).
// Прочие mutate (code_run → stdout/exit, fs_* → запись, office_* → COM-результат, system_volume →
// readback, app_launch → проверка процесса, *_open → открытая вкладка) САМОПОДТВЕРЖДАЮТСЯ своим
// tool_result — внешняя визуальная сверка им не нужна (иначе спамим экран-чтением на каждый код-ран).
// ui_ground здесь НЕ значится — это чтение (см. NEUTRAL_TOOLS выше).
const BLIND_MUTATE_TOOLS = new Set([
  "input_click", "input_key", "input_type", "browser_act", "web_act", "app_focus", "ui_invoke",
  // Волна 2 (2.4): input_mouse — тот же слепой SendInput (drag/удержание/колесо без обратной связи).
  // window_focus сюда НЕ входит: он самоподтверждается честным readback focused (как system_volume).
  "input_mouse",
  // Волна 2 (2.2): берст шагов — слепой по умолчанию; приложенное наблюдение (observed) снимает долг.
  "input_batch",
  // §AX-Ref: браузерный берст по ref — тоже слепой (исход формы/логина сверяется отдельно; browserBatch
  // намеренно НЕ ставит observed). toolEffect у него "mutate" по умолчанию (не в VERIFY/NEUTRAL).
  "browser_batch",
]);

/** Слепое ли это меняющее действие — то, чей успех надо подтвердить наблюдением, не доверяя «ok». */
export function isBlindMutate(name: string): boolean {
  return BLIND_MUTATE_TOOLS.has(name);
}

// Заявление о НАБЛЮДАЕМОМ содержимом/результате (его надо было сверить глазами перед «готово»). НЕ
// триггерит простое «открыл/запустил/готово» (там успех действия = цель). Триггерит «результаты/первый/
// на экране/вижу/показывает» — claim о содержимом, который без чтения = выдумка.
// (?<![а-яёa-z]) — кириллическая «граница слова» (JS \b на кириллице не работает): срабатывает на старте
// слова, а не внутри (чтобы «результат» не ловился в «безрезультатно», «видно» — в «очевидно»).
const OBSERVED_CLAIM =
  /(?<![а-яёa-z])(вижу|видно|на экране|показывает|показано|результат|первы[йм]|втор(ой|ым|ая)|вот (что|они|так|список|результ)|написано|выдача|на странице)/iu;

/** Заявляет ли финал НАБЛЮДАЕМЫЙ результат (который требовалось сверить глазами)? Чистая функция. */
export function claimsObservedResult(text: string): boolean {
  return OBSERVED_CLAIM.test(text || "");
}

/** Грубая классификация по тексту ошибки (для будущих специализированных фраз/телеметрии). */
export function classifyFailure(detail?: string): FailureClass {
  const d = (detail ?? "").toLowerCase();
  if (!d) return "unknown";
  if (/timeout|таймаут|долго|deadline|превышен/.test(d)) return "timeout";
  if (/лимит|spend|cap|quota/.test(d)) return "limit";
  if (/network|сет|offline|enotfound|econnrefused|fetch failed|связь/.test(d)) return "offline";
  if (/model|llm|anthropic|stub|стаб/.test(d)) return "model";
  return "tool";
}
