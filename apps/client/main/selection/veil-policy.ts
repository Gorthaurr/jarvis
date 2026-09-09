/**
 * §РЕЖИМ ВЫДЕЛЕНИЯ — политика вуали (контроль-5, ACT-6): ЧИСТЫЕ решения «что гейтить, что помечать, как читать
 * код вуали из скрипта» — одним модулем для раннего гейта dispatch, точки инжекции (input.ts) и code.run.
 * Раньше три куска одной политики жили в 740-строчном dispatch и расходились с input.ts (ACT-2: dispatch
 * отвергал input.key{mode:"up"}, а точка инжекции сознательно пропускала). Здесь нет Electron — таблица тестов
 * без моков.
 */
import type { ActionCommand, SkillStep } from "@jarvis/protocol";

/** Сенсоры, чей кадр/снимок под вуалью показывает НАШ оверлей, а не приложения владельца. */
export const SENSOR_KINDS_UNDER_VEIL = new Set<ActionCommand["kind"]>([
  "screen.capture",
  "screen.ocr",
  "screen.probe",
  "ui.snapshot",
  "context.read",
  "wait.for",
  // Контроль-7: `window.list` (EnumWindows — тот же источник, что wait.for{window}, от вуали не слепнет) и `ui.ground`
  // (поиск с фолбэком на весь стол — отдаёт handle целевого приложения, а не кадр) НЕ помечаются: пометка закрывала
  // ровно тот путь ui_invoke, который советует текст отказа, и давала два вердикта на один источник.
]);
/**
 * Условия wait.for, которые смотрят на ЭКРАН (под вуалью видят оверлей): ui (UIA активного окна = оверлей) и text (OCR
 * кадра). «window» (EnumWindows по заголовку/процессу) от вуали НЕ слепнет — контроль-6 (C5R-4): его достоверное met:true
 * выбрасывалось как «не сверка», а met:false превращалось в unknown. file/process/gsi/browser/sound вуали не касаются.
 */
export const VISUAL_WAIT_KINDS = new Set(["ui", "text"]);
// Текст пометки живёт ТОЛЬКО на сервере (dispatch-util.VEIL_NOTE): клиент шлёт признак overlayDrawing, не прозу (V5-5).

/** Скрипт jarvis SDK, упавший об вуаль, завершается ЭТИМ кодом (структурный сигнал, не текстовый маркер — ACT-4). */
export const OVERLAY_EXIT_CODE = 77;

/**
 * Что помечать «снято под вуалью»: сенсоры экрана/окон, кадр области, визуальные ожидания и ЛЮБОЙ результат с
 * fused-наблюдением (бесшумный ui.invoke/click{handle} под вуалью проходит, а наблюдение снято с окна оверлея —
 * контроль-4). Невизуальное wait.for (файл дописался) помечать нельзя: «кадр затемнён» про диск — ложь.
 */
export function veilRelevant(cmd: ActionCommand, data: unknown): boolean {
  if (cmd.kind === "wait.for") return VISUAL_WAIT_KINDS.has(String((cmd.condition as { kind?: unknown } | undefined)?.kind ?? ""));
  // Контроль-6 (C5R-5): снапшот ЯВНО заданного окна (pid) — UIA-дерево этого окна, не активного (оверлея): помечать
  // его «в кадре наш оверлей» = ложь, и сервер выбрасывал бы ровно тот путь ui_invoke, который советует текст отказа.
  if (cmd.kind === "ui.snapshot" && typeof cmd.pid === "number") return false;
  if (cmd.kind === "screen.selection") return cmd.op === "view";
  if (SENSOR_KINDS_UNDER_VEIL.has(cmd.kind)) return true;
  return typeof data === "object" && data !== null && "observation" in data;
}

/** input.key: отпускание (mode:"up") под вуалью пропускаем — побочного эффекта в оверлей нет, а залипшая клавиша вредит. */
export function keyGatedUnderVeil(mode?: "press" | "down" | "up"): boolean {
  return mode !== "up";
}

/**
 * МЫШЬ под вуалью гейтится ЦЕЛИКОМ, включая `op:"up"`.
 *
 * 🔴 Контроль-9 (mouse-up-terminates-owner-drawing) отменил послабление контроля-8: у клавиш `up` в окно рисования
 * безвреден, а у мыши `mouseup` — ГЛАВНОЕ СОБЫТИЕ этого окна. Владелец держит кнопку и обводит область; агентский
 * `input.mouse{op:"up"}` доходит до оверлея, и его обработчик немедленно ЗАВЕРШАЕТ выделение в текущей точке курсора
 * (а с заданными x/y сайдкар ещё и переставит курсор). Владелец получает область, которую не обводил, говорит «вот
 * тут» — и Джарвис уверенно смотрит не туда. Залипшую кнопку решаем иначе: удержания отпускаются в момент ЗАКРЫТИЯ
 * вуали (`releaseHeldPointer`, actuators/selection.ts), плюс watchdog удержаний сайдкара как второй рубеж.
 */
export function mouseGatedUnderVeil(_op?: string): boolean {
  return true;
}

/**
 * Контроль-9 (window-arrange-no-point-guard): одно знание о том, какие `window.arrange` отбирают фокус — и для
 * раннего гейта dispatch, и для гарда в САМОЙ точке действия (`arrangeWindow`): между ними лежит `listWindows`
 * с 8-секундным RPC, и вуаль успевает открыться внутри этого окна.
 */
export function arrangeGatedUnderVeil(op?: string): boolean {
  return op !== "minimize";
}

/**
 * Ранний гейт dispatch на время рисования: ЯВНО физический ввод (попал бы в оверлей и вернул ok = ложный успех) и
 * смена фокуса окна (ACT-5: сайдкар отбирает клавиатуру у окна рисования — Esc владельца уходит в чужое приложение).
 * Бесшумная ступень input.click (UIA invoke по handle/role) не гейтится — её советует сам текст отказа; физический
 * фолбэк такого клика ловит точка инжекции в input.ts.
 */
export function isVeilGatedInput(cmd: ActionCommand): boolean {
  switch (cmd.kind) {
    case "input.mouse":
      return mouseGatedUnderVeil(cmd.op); // контроль-8: отпускание зажатой кнопки проходит, как input.key{up}
    case "input.type":
    case "window.focus":
    case "app.focus":
    case "app.launch": // контроль-6 (C5R-6): новое окно приложения встаёт на передний план — тот же отбор клавиатуры
    case "browser.open": // контроль-7 (sensors-3): shell-open/CDP-окно браузера — на передний план (раннер это уже гейтил)
      return true;
    case "window.arrange": // контроль-7 (runner-1): и move активирует окно (SW_RESTORE свёрнутого/развёрнутого, maximizeAfterMove); только minimize — нет
      return arrangeGatedUnderVeil(cmd.op);
    case "input.key":
      return keyGatedUnderVeil(cmd.mode);
    case "input.click":
      return cmd.target.by === "coords" || cmd.method === "physical";
    default:
      return false;
  }
}

/** Смена фокуса/новое окно — «отбирает клавиатуру у окна рисования»; суффикс для текста отказа (одно знание с dispatch). */
export function focusStealsUnderVeil(kind: ActionCommand["kind"]): boolean {
  return kind === "window.focus" || kind === "app.focus" || kind === "app.launch" || kind === "window.arrange" || kind === "browser.open";
}

/**
 * Контроль-7 (sensors-2): какие шаги реплея ИНЖЕКТИРУЮТ что-то в GUI (после них «действие ушло, исход неизвестен» —
 * правда). wait/ground/verify/ui.ground ничего не инжектируют — «УХОДИЛО в GUI» про паузу было бы выдумкой.
 */
export const INJECTING_STEP_ACTIONS = new Set(["app.launch", "app.focus", "browser.open", "ui.invoke", "input.type", "input.key", "input.click", "input.mouse"]);
export function stepInjectsIntoGui(step: Pick<SkillStep, "action">): boolean {
  return INJECTING_STEP_ACTIONS.has(step.action);
}

/**
 * Контроль-6 (SR-C6-1): шаг реплея/берста/авто-макроса, который dispatch отверг бы под вуалью, — проверяется РАННЕРОМ
 * до executeStep (раннер зовёт актуаторы напрямую, мимо раннего гейта dispatch; гарды точки инжекции — защита в глубину).
 * Та же таблица, что isVeilGatedInput, в терминах SkillStep.
 */
export function stepGatedUnderVeil(step: Pick<SkillStep, "action" | "target" | "params">): boolean {
  const p = step.params ?? {};
  switch (step.action) {
    case "input.mouse":
      return mouseGatedUnderVeil(typeof p.op === "string" ? p.op : undefined); // контроль-8: та же таблица, что у dispatch
    case "input.type":
    case "app.focus":
    case "app.launch":
    case "browser.open": // shell-open поднимает окно браузера на передний план
      return true;
    case "input.key":
      return keyGatedUnderVeil(p.mode === "up" ? "up" : undefined);
    case "input.click":
      return step.target?.by === "coords" || p.method === "physical";
    default:
      return false;
  }
}

/** Что скрипт успел до остановки вуалью (контроль-6, V5-2): done — успешно ушедшие мутирующие вызовы SDK, injected — последний ушёл, но не подтверждён. */
export interface CodeRunVeilStop {
  reason: string;
  done: number;
  injected: boolean;
}

/**
 * code.run: скрипт SDK лёг об вуаль — по ВЫДЕЛЕННОМУ коду выхода (jarvis.py: JarvisVeilExit = SystemExit(77)) И маркеру
 * `[overlay_drawing] done=N injected=0|1 …` в stderr (печатается В МОМЕНТ raise): одного кода мало (чужой python может
 * выйти 77 сам), одного маркера мало (маркер в середине вывода перекрывал настоящую ошибку в хвосте, маркер в stdout
 * терялся). Таймаут — не вуаль; SDK есть только у python (node/powershell моста не видят) — для них любой код не вуаль.
 * Контроль-6 (V5-2): скрипт, успевший N кликов/Enter до остановки, не «действие не выполнено» — done едет как stepIndex.
 */
export function overlayDrawingFromCodeRun(r: { exitCode: number; stderr?: string; timedOut?: boolean; lang?: string }): CodeRunVeilStop | null {
  if (r.timedOut || r.exitCode !== OVERLAY_EXIT_CODE) return null;
  if (r.lang !== undefined && r.lang !== "python") return null;
  const line = (r.stderr || "").split(/\r?\n/u).reverse().find((l) => l.includes("[overlay_drawing]"));
  if (line === undefined) return null;
  let rest = line.replace(/^.*?\[overlay_drawing\]\s*/u, "").trim();
  const done = /^done=(\d+)/u.exec(rest);
  let n = 0;
  let injected = false;
  if (done) {
    n = Number(done[1]);
    rest = rest.slice(done[0].length).trim();
    const inj = /^injected=([01])/u.exec(rest);
    if (inj) {
      injected = inj[1] === "1";
      rest = rest.slice(inj[0].length).trim();
    }
  }
  return { reason: rest || "поверх экрана вуаль режима выделения", done: n, injected };
}
