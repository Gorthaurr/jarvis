/**
 * Диспетчер актуаторов: ActionCommand -> ActionResult (§5, §6).
 *
 * Контракт (§5): на КАЖДЫЙ ActionCommand клиент обязан вернуть ровно один ActionResult,
 * корреляция по commandId (= envelope.id). durationMs обязателен.
 *
 * Реализованы: app.launch/focus, browser.open/act/read (apps.ts/browser.ts);
 * input.type/key/click, ui.ground/invoke, context.read — через нативный win-сайдкар
 * (sidecar-client, UIAutomation+SendInput); code.run (code-runner); skill.execute
 * (skill-runner); message.send (userbot); order.place (browser). Ввод/UIA требуют
 * запущенного сайдкара — если он не поднят, актуатор честно вернёт runtime-ошибку.
 * screen.capture (§ зрение) — Electron desktopCapturer, см. screen.ts. НЕ реализованы:
 * demo.record как ActionCommand (M4 — запись навыка инициируется отдельным путём, не через dispatch).
 */
import { powerMonitor } from "electron";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import * as apps from "./apps.js";
import * as input from "./input.js";
import * as ground from "./ground.js";
import * as windows from "./windows.js";
import * as audioSessions from "./audio-sessions.js";
import * as windowArrange from "./window-arrange.js";
import * as browser from "./browser.js";
import * as codeRunner from "./code-runner.js";
import * as fs from "./fs.js";
import { viewFile } from "./file-view.js";
import { type CaptureRect, captureScreen, getLastCaptureMapping, probeScreen } from "./screen.js";
import { selectionClear, selectionStart, selectionView } from "./selection.js";
import { selectionStore } from "../selection/store.js";
import { OVERLAY_EXIT_CODE, focusStealsUnderVeil, isVeilGatedInput, overlayDrawingFromCodeRun, veilRelevant } from "../selection/veil-policy.js";
import { DrawingOverlayError } from "./input.js";
import { act } from "./act.js";
import { ActPartialError } from "./act-do.js";
import { screenOcr, waitFor } from "./sensors-cheap.js";
import { captureUiFingerprint, observeAfterAction } from "./observe.js";
import * as system from "./system.js";
import * as office from "./office.js";
import * as obs from "./obs.js";
import { outcomeToActionResult, runSkill } from "../skill-runner/index.js";
import { createClientActuator } from "../skill-runner/client-actuator.js";
import * as messaging from "./messaging.js";
import { jarvisBrowser } from "./jarvis-browser.js";
import { lastJarvisInput, lastOwnerInput } from "./input-mark.js";
import { isUserActive, ownerPresence } from "./user-presence.js";
import { monitors } from "../monitors.js";

const log = createLogger("actuators");

/**
 * НЕ МЕШАТЬ ПОЛЬЗОВАТЕЛЮ (§): инъекция физического ввода (мышь/клавиатура через SendInput) уводит
 * курсор и шлёт нажатия в активное окно — если пользователь СЕЙЧАС играет/работает, это сбивает его.
 * Правило: пользователь простаивает (не вводил ничего N сек) → действуем; пользователь активен → НЕ
 * лезем, честно сообщаем (модель озвучит «вижу, вы заняты — не хочу мешать»). Сигнал — системное время
 * простоя (Electron powerMonitor.getSystemIdleTime, секунды с последнего ввода ЛЮБОГО источника).
 */
const USER_ACTIVE_THRESHOLD_MS = 4000;
/**
 * §Волна3 ревью (#2): бюджет времени клиентского реплея навыка. runSkill честно останавливается по его
 * исчерпании — ДО серверного потолка SKILL_EXECUTE_SERVER_TIMEOUT_MS (130с), чтобы сервер не начал
 * кликать LLM-петлёй параллельно ещё идущему реплею. Ревью фиксов, 2-й проход (R3): худший перебег
 * за дедлайн — начатая у границы попытка: executeStep ≤ ~25с (hard-таймаут лаунчера app.launch; или
 * 2×UIA по 12с) ЛИБО короткий шаг + один expect-опрос ≤ ~20с (visual = скрин+OCR, таймаут сайдкара
 * 20с; при исчерпанном бюджете опрос теперь пропускается) + sleep ретрая ≤1.2с ≈ 26с → кламп 80с
 * даёт 80+26=106 < 130 с запасом. Поднимаешь кламп — пересчитай слак (и protocol/constants.ts).
 */
const SKILL_REPLAY_BUDGET_MS = (() => {
  const n = Number.parseInt(process.env.JARVIS_SKILL_REPLAY_BUDGET_MS ?? "", 10);
  return Number.isFinite(n) && n >= 10_000 && n <= 80_000 ? n : 80_000;
})();
/** Ввод САМОГО Джарвиса (SendInput) тоже сбрасывает системный idle — не считаем его «активностью юзера». */
const JARVIS_INPUT_TOLERANCE_MS = 900;
/** Когда Джарвис последний раз сам инжектил ввод (для отсечки собственного ввода из детекта активности). */
// Реестр собственного ввода переехал в input-mark.ts (адверс-ревью 2026-09-02): отметка ставится
// ТАМ, ГДЕ ВВОД ИНЖЕКТИТСЯ, — иначе мимо неё шли реплей навыка, медиа-клавиши и tier0-громкость.
/** Последний ввод, признанный ВЛАДЕЛЬЦЕВЫМ (не нашим) — для честного присутствия в снимке ПК. */
let lastUserInputAt = 0;
/** Команды, которые ФИЗИЧЕСКИ инжектят ввод в сессию пользователя (в отличие от UIA-invoke/CDP). */
const PHYSICAL_INPUT_KINDS = new Set<ActionCommand["kind"]>(["input.click", "input.type", "input.key", "input.mouse", "gui.act"]); // W4: act может уйти физическим вводом
/**
 * Команды, после которых снимается fused-наблюдение → для них нужен снимок структуры ДО действия
 * (иначе дельту не с чем считать). Список ровно повторяет call-site'ы observeAfterAction.
 */
const OBSERVING_KINDS = new Set<ActionCommand["kind"]>([
  "input.click",
  "input.type",
  "input.key",
  "input.mouse",
  "ui.invoke",
  "skill.execute",
]);

/**
 * Куда МЫ СОБИРАЕМСЯ ткнуть — известно ДО действия и только для координатных целей. Нужно снимку
 * «до» на UIA-слепом окне (игра/canvas): OCR сравнивается по ОДНОЙ И ТОЙ ЖЕ области, иначе сравнение
 * бессмысленно. Цель по тексту/роли резолвится уже в момент клика — там точки заранее нет, и
 * наблюдение честно останется без дельты (слабым), а не выдаст окрестность за сверку исхода.
 */
export function plannedClickPoint(cmd: ActionCommand): { x: number; y: number } | undefined {
  const toScreen = (x: number, y: number, space?: "screen"): { x: number; y: number } => {
    if (space === "screen") return { x, y };
    const m = getLastCaptureMapping();
    return m ? { x: m.boundsX + x / m.scale, y: m.boundsY + y / m.scale } : { x, y };
  };
  if (cmd.kind === "input.click" && cmd.target.by === "coords") return toScreen(cmd.target.x, cmd.target.y, cmd.target.space);
  if (cmd.kind === "input.mouse" && cmd.op === "drag" && cmd.toX !== undefined && cmd.toY !== undefined) {
    return toScreen(cmd.toX, cmd.toY, cmd.space);
  }
  return undefined;
}

/**
 * Будет ли после этой команды снято fused-наблюдение. ЧИСТАЯ функция — ОДИН источник правды для
 * снимка «до» и для самого наблюдения.
 *
 * Ревью 2026-09-01: решение по одному лишь `kind` было неверным — наблюдение условно ВНУТРИ вида
 * (input.key не наблюдает середину жеста down/up, input.mouse — только drag/wheel/up). Снимок «до»
 * при этом делался всё равно: блокирующий обход UIA перед КАЖДЫМ удержанием клавиши в игре, и его
 * результат сразу выбрасывался. Тайминг-зависимые жесты от этого едут.
 */
export function willObserve(cmd: ActionCommand): boolean {
  if (!OBSERVING_KINDS.has(cmd.kind)) return false;
  if (cmd.kind === "input.key") return cmd.mode !== "down" && cmd.mode !== "up";
  if (cmd.kind === "input.mouse") return cmd.op === "drag" || cmd.op === "wheel" || cmd.op === "up";
  return true;
}

/**
 * Нужен ли снимок ДО действия. Уже НЕ равно willObserve (адверс-ревью 2026-09-01):
 * — `input.mouse{op:"up"}` наблюдают ПОСЛЕ, но снимок ДО пришёлся бы на момент, когда кнопка мыши
 *   ФИЗИЧЕСКИ зажата предыдущим `down` — блокирующий обход UIA прямо посреди жеста рвёт drag;
 * — `skill.execute` идёт под собственным бюджетом реплея, и лишние секунды съедают слак, ради
 *   которого этот бюджет и считался («нет двух писателей в GUI»); дельта между состояниями,
 *   разделёнными десятками секунд берста, всё равно малоинформативна.
 */
export function needsBeforeSnapshot(cmd: ActionCommand): boolean {
  if (!willObserve(cmd)) return false;
  if (cmd.kind === "input.mouse" && cmd.op === "up") return false;
  if (cmd.kind === "skill.execute") return false;
  return true;
}

/**
 * Активен ли пользователь ПРЯМО СЕЙЧАС (недавно вводил сам, а не Джарвис). Логика — в user-presence.
 * Экспортируется, чтобы skill-runner применял ТОТ ЖЕ гейт присутствия к физ.вводу проактивного навыка
 * (иначе skill.execute → createClientActuator дёргал бы input.* в обход USER_BUSY-сторожа dispatch, H5).
 */
export function userActiveNow(): boolean {
  let idleMs: number;
  try {
    idleMs = Math.round(powerMonitor.getSystemIdleTime() * 1000);
  } catch {
    return false; // нет сигнала простоя — не блокируем (fail-open)
  }
  return isUserActive({
    idleMs,
    lastJarvisInputAt: lastJarvisInput(),
    now: Date.now(),
    thresholdMs: USER_ACTIVE_THRESHOLD_MS,
    toleranceMs: JARVIS_INPUT_TOLERANCE_MS,
  });
}

/**
 * Присутствие ВЛАДЕЛЬЦА для снимка ПК (§Б3): «за ПК» / «отошёл» / «не знаю». В отличие от
 * `userActiveNow()` (гейт ввода, окно 4с) здесь окно минутное — снимок отвечает на вопрос «человек
 * рядом», а не «прямо сейчас держит мышь». Собственный ввод Джарвиса вычитается: без этого снимок
 * утверждал «владелец за ПК» на КАЖДОЙ GUI-задаче, и модель объясняла этим свои провалы.
 */
export function ownerPresenceNow(): { state: "at_pc" | "away" | "unknown"; idleMin: number } {
  let idleMs: number;
  try {
    idleMs = Math.round(powerMonitor.getSystemIdleTime() * 1000);
  } catch {
    return { state: "unknown", idleMin: 0 }; // нет сигнала — молчим, а не выдумываем присутствие
  }
  // Граунд-трус сайдкара (он отфильтровал нашу синтетику по dwExtraInfo) главнее эвристики по
  // глобальному простою: последний ЖИВОЙ ввод владельца известен точно, а не выведен вычитанием.
  const truth = lastOwnerInput();
  if (truth > lastUserInputAt) lastUserInputAt = truth;
  const r = ownerPresence({ idleMs, lastJarvisInputAt: lastJarvisInput(), lastUserInputAt, now: Date.now(), toleranceMs: JARVIS_INPUT_TOLERANCE_MS });
  lastUserInputAt = r.lastUserInputAt;
  return { state: r.state, idleMin: Math.round(r.idleMs / 60_000) };
}

/** Собрать успешный результат с замером длительности. */
function okResult(commandId: string, startedAt: number, data?: unknown): ActionResult {
  return { commandId, ok: true, data, durationMs: Date.now() - startedAt };
}

/** Собрать результат-ошибку (коды строго из протокола). */
function errResult(
  commandId: string,
  startedAt: number,
  code: NonNullable<ActionResult["error"]>["code"],
  message: string,
): ActionResult {
  return { commandId, ok: false, error: { code, message }, durationMs: Date.now() - startedAt };
}

/** Честный «не реализовано на этом milestone» (§17). */
function notImplemented(commandId: string, startedAt: number, milestone: string): ActionResult {
  return errResult(commandId, startedAt, "runtime", `not implemented (${milestone})`);
}

/**
 * Исполнить команду. commandId приходит из envelope.id (см. transport).
 * Любое исключение из актуатора маппится в error.runtime — наружу не утекает.
 */
// Политика вуали (что гейтить / что помечать / как читать код вуали из скрипта) — ОДИН чистый модуль
// `selection/veil-policy.ts` на dispatch, точку инжекции и code.run (контроль-5, ACT-6).

export async function dispatch(commandId: string, cmd: ActionCommand): Promise<ActionResult> {
  // Контроль-4: вуаль судится по ОКНУ команды, а не по состоянию в момент возврата — захват длится сотни мс,
  // и если владелец отпустил мышь до возврата, затемнённый кадр с подсказкой уезжал без пометки.
  const veiledBefore = selectionStore.drawing;
  const t0 = Date.now();
  const result = await dispatchInner(commandId, cmd);
  const veiledWindow = veiledBefore || selectionStore.drawing || selectionStore.drawingEndedAfter(t0);
  // Контроль-5 (ACT-1): wait.for живёт до минуты — вуаль судится ПО РЕШАЮЩЕМУ ОПРОСУ (sensors-cheap ставит
  // data.veiled), а не по окну всей команды: честное met:true на чистом экране после закрытия вуали не выбрасывается.
  // Контроль-6 (C5R-8): skill.execute живёт до 90 с — то же: по окну САМОГО наблюдения (data.veiled ставит case ниже).
  const veiled = cmd.kind === "wait.for" || cmd.kind === "skill.execute" ? (result.data as { veiled?: boolean } | undefined)?.veiled === true : veiledWindow;
  // §режим выделения (контроль-ревью 2026-09-05): пока вуаль на экране, сенсоры видят ЕЁ — честно помечаем
  // результат, чтобы затемнённый кадр и подсказка оверлея не читались как состояние приложений.
  // Признак — только overlayDrawing; текст пометки формулирует сервер (V5-5: две редакции одного статуса — путаница).
  if (result.ok && veiled && result.data && typeof result.data === "object" && veilRelevant(cmd, result.data)) {
    const data: Record<string, unknown> = { ...(result.data as Record<string, unknown>), overlayDrawing: true };
    // Ожидание, ослепшее вуалью, не вправе отвечать «достоверно не наступило/наступило» (watch-предикат читает unknown).
    if (cmd.kind === "wait.for") data.unknown = true;
    return { ...result, data };
  }
  return result;
}

async function dispatchInner(commandId: string, cmd: ActionCommand): Promise<ActionResult> {
  const startedAt = Date.now();
  log.info(`dispatch ${cmd.kind} (commandId=${commandId})`);

  try {
    // 🔴 §режим выделения (2026-09-03): пока владелец ОБВОДИТ область, поверх экрана лежит окно-оверлей,
    // которое ловит мышь. Физический клик агента в этот момент попал бы В ОВЕРЛЕЙ, а актуатор вернул бы
    // ok — ложный успех ровно того класса, который проект не прощает («нажал» в пустоту и отчитался).
    // Гейтим ФИЗИЧЕСКИЙ ввод (мышь/клавиатура) и называем ПРАВДИВУЮ причину: ввод занят владельцем, а не
    // «вы за компьютером» (выдуманная причина — отдельный класс дефектов, разбор «Доты» 2026-09-02).
    // Фаза висящей рамки НЕ гейтится: она click-through и ввод не перехватывает.
    // Ранний честный отказ здесь; ЗАЩИТА В ГЛУБИНУ — в самой точке инжекции (input.ts): реплей навыка,
    // input_batch и SDK-мост зовут input.* мимо dispatch (адверс-ревью 2026-09-05, тот же класс, что H5).
    // Ранний отказ — только для ЯВНО физического ввода: бесшумную ступень input.click (UIA invoke по
    // handle/role, мышь не трогает) гейтить нельзя — её же советует текст отказа. Физический фолбэк
    // бесшумного клика поймает гейт в input.ts.
    // Контроль-5: условие гейта — из veil-policy (общее с точкой инжекции: input.key{mode:"up"} проходит, фокус окна — нет).
    const drawBlock = isVeilGatedInput(cmd) ? selectionStore.physicalInputBlockReason() : null;
    if (drawBlock) {
      log.info(`physical-input «${cmd.kind}» отклонён: открыт оверлей режима выделения`);
      // Контроль-3: код ОДИН на оба рубежа (здесь и в точке инжекции) — сервер узнаёт вуаль только по
      // `overlay_drawing`; прежний «denied» уходил в петлю обычным провалом и кормил §7-эскалацию.
      const drawMsg = focusStealsUnderVeil(cmd.kind) || (cmd.kind === "gui.act" && Boolean(cmd.app))
        ? `${drawBlock} Смена фокуса окна отобрала бы клавиатуру у окна рисования — Esc владельца ушёл бы в чужое приложение.`
        : drawBlock;
      return errResult(commandId, startedAt, "overlay_drawing", drawMsg);
    }

    // §: НЕ МЕШАТЬ активному пользователю — но ТОЛЬКО когда действие ПРОАКТИВНОЕ (Джарвис сам затеял).
    // ЗАПРОШЕННЫЙ физ-ввод (юзер сам попросил настроить/кликнуть) НЕ блокируем: он в курсе, мешать нечему
    // (фикс «дал сложную задачу — а он отказался: вы активны в браузере»). Глушим лишь `proactive===true`.
    const isProactive = cmd.origin === "proactive" || cmd.proactive === true; // §бесшумный-ввод: канон — origin
    if (isProactive && PHYSICAL_INPUT_KINDS.has(cmd.kind) && userActiveNow()) {
      const idleS = (() => {
        try {
          return powerMonitor.getSystemIdleTime().toFixed(1);
        } catch {
          return "?";
        }
      })();
      log.info(`physical-input «${cmd.kind}» отложен: пользователь активен (idle ${idleS}s)`);
      return errResult(
        commandId,
        startedAt,
        "denied",
        `USER_BUSY: пользователь сам за вводом (~${idleS}с назад), физическую мышь/клавиатуру сейчас не трогаю. ` +
          `НЕ сдавайся и НЕ перекладывай на пользователя. Если это ВЕБ — сделай через browser_open/browser_act ` +
          `(они работают в его вкладках и НЕ трогают мышь/клаву, мешать не будут). Если нативное окно/игра — ` +
          `повтори через пару секунд или зайди иначе (code_run и т.п.). ЗАПРЕЩЕНО говорить «сделайте сами», ` +
          `«нажмите Ctrl+…», «не умею» — работу с себя не снимай.`,
      );
    }

    // 🔴 Снимок структуры окна ДО действия — база для наблюдения-ДЕЛЬТЫ (форензика 2026-09-01:
    // прежнее наблюдение описывало окно, а не изменение, и модель всё равно шла за скриншотом —
    // пара «screen_capture → input_click» самая частая во всей истории). Снимаем ТОЛЬКО для
    // действий, которые потом наблюдают: лишний опрос UIA на каждую команду не нужен.
    // Не вышло (сайдкар лежит/долго) → undefined: наблюдение честно вернётся в прежний режим.
    const beforeUi = needsBeforeSnapshot(cmd) ? await captureUiFingerprint(plannedClickPoint(cmd)) : undefined;

    switch (cmd.kind) {
      // ── РЕАЛЬНО в M0 ──────────────────────────────────────────
      case "app.launch": {
        const out = await apps.launchApp(cmd.app);
        return okResult(commandId, startedAt, out);
      }
      case "app.focus": {
        const out = await apps.focusApp(cmd.app);
        // ЧЕСТНОСТЬ (баг из живого прогона): focused===false → приложение не запущено / окно не вышло
        // на передний план. НЕ возвращаем ok, иначе модель соврёт «переключил» на несуществующее.
        if (!out.focused) {
          return errResult(
            commandId,
            startedAt,
            "not_found",
            `не сфокусировал «${cmd.app}»: приложение не запущено или окно не вышло на передний план. Запусти его (app_launch) или проверь имя.`,
          );
        }
        return okResult(commandId, startedAt, out);
      }
      case "app.close": {
        // §6 БЕЗОПАСНОЕ закрытие по процессу (НЕ Alt+F4): self-exclusion внутри closeApp
        // не даст закрыть сам Джарвис/критический процесс.
        const out = await apps.closeApp(cmd.app, cmd.force ?? false);
        // ЧЕСТНОСТЬ (баг из живого прогона): closed===0 → НИЧЕГО не закрыли (процесс не найден/не
        // поддался graceful-закрытию). НЕ возвращаем ok, иначе модель соврёт «закрыл». Пусть увидит
        // провал и зайдёт иначе (force=true / другое имя процесса / проверка глазами).
        if (out.closed === 0) {
          return errResult(
            commandId,
            startedAt,
            "not_found",
            `не закрыл «${cmd.app}»: подходящий запущенный процесс не найден или не закрылся штатно. ` +
              `Проверь имя процесса или повтори с force=true (жёсткое закрытие).`,
          );
        }
        return okResult(commandId, startedAt, out);
      }
      case "browser.open": {
        // inDefault (консьерж «просто открой/включи»): открыть в ДЕФОЛТНОМ (залогиненном) браузере
        // пользователя через shell — его сессия/логины, мгновенно, без CDP-инстанса и без 12с
        // singleton-лага, физическую мышь НЕ трогаем. Управление (browser.act) тут не нужно.
        if (cmd.inDefault) {
          const out = await apps.launchApp(cmd.url);
          return okResult(commandId, startedAt, { ...out, url: cmd.url, controlled: false, inDefault: true });
        }
        // Управляемый браузер (CDP) — чтобы дальше работали browser.act/read на этой же
        // странице. Нет Chrome / сбой CDP → мягкий откат на запуск дефолтного браузера.
        try {
          await browser.open(cmd.url);
          return okResult(commandId, startedAt, { url: cmd.url, controlled: true });
        } catch (e) {
          log.warn(`browser.open CDP не удался (${e instanceof Error ? e.message : String(e)}) — откат на launchApp`);
          const out = await apps.launchApp(cmd.url);
          return okResult(commandId, startedAt, { ...out, controlled: false });
        }
      }

      // ── Синтетический ввод (§Волна2 2.1: fused act+observe — наблюдение в ТОМ ЖЕ результате) ──
      case "input.type": {
        await input.typeText(cmd.text);

        const observation = await observeAfterAction({ settleMs: 150, before: beforeUi });
        return okResult(commandId, startedAt, observation ? { observation } : undefined);
      }
      case "input.key": {
        await input.pressKey(cmd.combo, cmd.mode, cmd.scancode);

        // Игровое удержание (down/up) — середина жеста, наблюдение неуместно (см. Волна2 2.1).
        const observation = cmd.mode === "down" || cmd.mode === "up" ? undefined : await observeAfterAction({ settleMs: 250, before: beforeUi });
        return okResult(commandId, startedAt, observation ? { observation } : undefined);
      }
      case "input.click": {
        // §бесшумный-ввод: по умолчанию silent (без курсора); физ.клик-фолбэк возвращает курсор, ЕСЛИ юзер
        // сейчас НЕ двигает мышь сам (иначе не дёргаем — оставляем курсор там, где он у него).
        // Разрешённые экранные координаты возвращаем в data — сервер компилирует из них реплей-макрос (§8).
        const clicked = await input.click(cmd.target, cmd.method ?? "silent", !userActiveNow(), {
          button: cmd.button,
          count: cmd.count,
        });

        // §Волна2 (2.1): наблюдение после клика — a11y-выжимка / OCR региона вокруг точки.
        const observation = await observeAfterAction({
          settleMs: 400,
          clickPoint: clicked ? { x: clicked.screenX, y: clicked.screenY } : undefined,
          before: beforeUi,
        });
        return okResult(commandId, startedAt, observation ? { ...clicked, observation } : clicked);
      }
      case "input.mouse": {
        // §Волна2 (2.4): полная мышь — hover/удержание/колесо/перетаскивание (DnD, контекст-меню, игры).
        await input.mouse(cmd);

        // Наблюдение — для завершённых жестов (drag/wheel/up); move/down — середина жеста.
        const wantsObserve = willObserve(cmd);
        // Точка для OCR-региона — конец drag в экранных DIP (координаты команды — vision-координаты
        // последнего снимка, кроме space:"screen"; маппинг тот же, что внутри input.mouse).
        const dragEnd = (() => {
          if (cmd.op !== "drag" || cmd.toX === undefined || cmd.toY === undefined) return undefined;
          if (cmd.space === "screen") return { x: cmd.toX, y: cmd.toY };
          const m = getLastCaptureMapping();
          return m ? { x: m.boundsX + cmd.toX / m.scale, y: m.boundsY + cmd.toY / m.scale } : { x: cmd.toX, y: cmd.toY };
        })();
        const observation = wantsObserve
          ? await observeAfterAction({ settleMs: 400, clickPoint: dragEnd, before: beforeUi })
          : undefined;
        return okResult(commandId, startedAt, observation ? { op: cmd.op, observation } : { op: cmd.op });
      }
      case "gui.act": {
        // W4 «Руки»: поиск → действие → сверка внутри ОДНОГО вызова (act.ts); снимок «до» act снимает сам —
        // после фокуса окна и поиска цели (needsBeforeSnapshot для него false осознанно).
        const out = await act(cmd, { restoreCursor: !userActiveNow() });
        return okResult(commandId, startedAt, out);
      }
      case "ui.invoke": {
        await ground.invoke(cmd.target, cmd.pattern, cmd.value);
        const observation = await observeAfterAction({ settleMs: 350, before: beforeUi });
        return okResult(commandId, startedAt, observation ? { observation } : undefined);
      }
      case "ui.ground": {
        const g = await ground.ground(cmd.query);
        return okResult(commandId, startedAt, g);
      }
      case "ui.snapshot": {
        // §Волна2 (2.4): set-of-marks — интерактивные элементы окна одним дешёвым списком.
        const snap = await ground.uiSnapshot(cmd.pid, cmd.maxItems);
        return okResult(commandId, startedAt, snap);
      }
      case "window.list": {
        // §Волна2 (2.4): окна верхнего уровня on-demand («появилось ли окно» за миллисекунды).
        return okResult(commandId, startedAt, { windows: await windows.listWindows() });
      }
      case "window.focus": {
        // §Волна2 (2.4): фокус через сайдкар (SetForegroundWindow+AttachThreadInput, честный readback);
        // провал ЛЮБОЙ ветки (не сфокусировал / окно не найдено / сайдкар лежит — ревью: раньше throw
        // проскакивал мимо фолбэка) → AppActivate-путь по query, затем честная ошибка.
        let r: Awaited<ReturnType<typeof windows.focusWindow>> | null = null;
        let sidecarErr = "";
        try {
          r = await windows.focusWindow({ hwnd: cmd.hwnd, query: cmd.query });
        } catch (e) {
          sidecarErr = e instanceof Error ? e.message : String(e);
        }
        if (r?.focused) {

          return okResult(commandId, startedAt, r);
        }
        if (cmd.query) {
          const legacy = await apps.focusApp(cmd.query);
          if (legacy.focused) {

            return okResult(commandId, startedAt, { focused: true, hwnd: r?.hwnd ?? 0, title: r?.title ?? cmd.query, via: "AppActivate" });
          }
        }
        return errResult(
          commandId,
          startedAt,
          "runtime",
          r
            ? `окно найдено («${r.title}»), но фокус не перешёл (foreground-lock). Попробуй app_focus или проверь, не заблокирован ли рабочий стол.`
            : `фокус не взят: ${sidecarErr || "окно не найдено"}. Проверь имя/hwnd через window_list.`,
        );
      }
      case "window.arrange": {
        // Цель: hwnd напрямую или поиск по подстроке заголовка/процесса (как window.focus).
        // Текущий rect нужен, чтобы перенос СОХРАНИЛ размер окна, а не растянул его.
        const all = await windows.listWindows();
        const q = (cmd.query ?? "").trim().toLowerCase();
        const target =
          (cmd.hwnd ? all.find((w) => w.hwnd === cmd.hwnd) : undefined) ??
          (q ? all.find((w) => w.title.toLowerCase().includes(q) || w.process.toLowerCase().includes(q)) : undefined);
        if (!target) {
          return errResult(
            commandId,
            startedAt,
            "runtime",
            cmd.hwnd
              ? `окна с hwnd ${cmd.hwnd} нет — перечитай window_list`
              : `окно «${cmd.query ?? ""}» не найдено среди открытых — проверь window_list`,
          );
        }
        const r = await windowArrange.arrangeWindow({
          hwnd: target.hwnd,
          op: cmd.op,
          monitor: cmd.monitor,
          current: target.rect,
          maximizeAfterMove: cmd.maximizeAfterMove,
        });
        return okResult(commandId, startedAt, { ...r, title: target.title, process: target.process });
      }
      case "audio.sessions": {
        // Кто СЕЙЧАС звучит (Core Audio sessions): процесс, состояние, мьют, громкость, пик.
        // Ответ на «что это за звук?» — первая строка списка (сортировка по пику).
        return okResult(commandId, startedAt, { sessions: await audioSessions.listAudioSessions() });
      }
      case "audio.set": {
        // Точечный мьют/громкость приложения. Актуатор САМ падает ошибкой, если подходящей
        // сессии нет (глушить нечего) — ложного «готово» тут быть не может.
        const r = await audioSessions.setAudioSession({
          pid: cmd.pid,
          process: cmd.process,
          mute: cmd.mute,
          level: cmd.level,
        });
        return okResult(commandId, startedAt, r);
      }
      case "browser.act":
        await browser.act(cmd.intent, cmd.params);
        return okResult(commandId, startedAt);
      case "browser.read": {
        const r = await browser.read(cmd.selectorIntent);
        return okResult(commandId, startedAt, r);
      }
      case "code.run": {
        if (cmd.background) {
          // Фоновое задание: ответ сразу; исход — job.status. Честность: «запущено» ≠ «сделано», это в note.
          const j = await codeRunner.startJob(cmd.lang, cmd.code, { cwd: cmd.cwd });
          return okResult(commandId, startedAt, { ...j, background: true, note: "фоновое задание запущено; исход НЕ известен — проверяй job.status, результат сверяй по файлу/выводу" });
        }
        const r = await codeRunner.run(cmd.lang, cmd.code, { cwd: cmd.cwd, timeoutMs: cmd.timeoutMs });
        // ЧЕСТНОСТЬ (ревью C1): ненулевой exitCode = скрипт УПАЛ (исключение / sys.exit(1) / таймаут).
        // Раньше всегда okResult → модель видела «успех» и врала «готово, результат N», а exitCode/stderr
        // прятались в JSON. Теперь провал явный: модель видит ошибку и заходит иначе.
        if (r.exitCode !== 0) {
          // Контроль-4: SDK-мост (jarvis.py) помечает отказ вуали маркером в тексте исключения — иначе третий
          // документированный путь ввода (code_run + jarvis.click) снова кормил §7-эскалацию как провал модели.
          // Контроль-5 (ACT-4): признак структурный — выделенный exit-код jarvis.py (excepthook), не маркер где-то в stderr.
          const veilStop = overlayDrawingFromCodeRun({ ...r, lang: cmd.lang });
          if (veilStop) {
            // Контроль-6 (V5-2): что скрипт УСПЕЛ до остановки — stepIndex (как у реплея) + хвост stdout: иначе
            // сделанные N кликов/Enter уезжали как «действие не выполнено», и «повтори» дублировало их.
            const doneNote = veilStop.done > 0 ? ` Успешно ушедших действий до остановки: ${veilStop.done} — они НЕ откатываются.` : "";
            const injNote = veilStop.injected ? " Последнее действие УШЛО, его исход не подтверждён." : "";
            const tail = (r.stdoutTail ?? r.stdout).slice(-300); // контроль-7 (sdk-4): настоящий хвост, не хвост головы
            const out = errResult(commandId, startedAt, "overlay_drawing", `скрипт остановлен: ${veilStop.reason}${doneNote}${injNote}${tail ? ` | stdout${r.truncated ? " (усечён)" : ""}: ${tail}` : ""}`);
            return { ...out, ...(veilStop.done > 0 ? { stepIndex: veilStop.done } : {}), ...(veilStop.injected ? { stepActionInjected: true } : {}) };
          }
          return errResult(
            commandId,
            startedAt,
            "runtime",
            `код завершился с кодом ${r.exitCode}${r.timedOut ? " (ТАЙМАУТ: окно исполнения исчерпано, процесс убит — для долгого запуска задай timeoutMs или background:true)" : r.exitCode === -1 ? " (прервано)" : ""}. ` +
              `stderr: ${(r.stderr || "").slice(0, 500) || "(пусто)"}${r.stdout ? ` | stdout: ${r.stdout.slice(0, 300)}` : ""}`,
          );
        }
        // Контроль-7 (sdk-3): exit 0, но в stderr наш маркер — скрипт ПЕРЕХВАТИЛ отказ вуали (голый except/BaseException) и
        // продолжил; чистый ok был бы ложным успехом при известном клиенту отказе. Не ошибка (скрипт мог сделать иное),
        // но исход НЕ ПОДТВЕРЖДЁН — сервер ставит uncertain.
        if (cmd.lang === "python" && (r.stderr || "").includes("[overlay_drawing]")) {
          const caught = overlayDrawingFromCodeRun({ ...r, exitCode: OVERLAY_EXIT_CODE, lang: cmd.lang });
          return okResult(commandId, startedAt, {
            ...r,
            overlayCaught: true,
            overlayReason: caught?.reason ?? "поверх экрана вуаль режима выделения",
            note: "скрипт перехватил отказ вуали режима выделения и продолжил — часть действий НЕ выполнена; исход НЕ подтверждён, сверь состояние",
          });
        }
        return okResult(commandId, startedAt, r);
      }
      case "job.status": {
        const js = await codeRunner.jobStatus(cmd.jobId, cmd.kill === true);
        const exitCode = js.exitCode;
        const finished = !js.running && typeof exitCode === "number";
        // Контроль-6 (C5R-7): фоновый python с SDK, легший об вуаль, — тот же признак, что у синхронного code.run
        // (признак у одного потребителя из двух = дефект). Поле НЕ overlayDrawing: это не «снято под вуалью» сейчас.
        // Контроль-9 (job-caught-marker-lost-in-tail): маркер берём из ПОЛНОГО stderr (js.overlayMarker), хвост — лишь фолбэк.
        const veilStderr = js.overlayMarker ?? js.stderrTail;
        const v = typeof exitCode === "number" && !js.running ? overlayDrawingFromCodeRun({ exitCode, stderr: veilStderr, lang: js.lang }) : null;
        if (v) {
          return okResult(commandId, startedAt, {
            ...js,
            overlayStopped: true,
            overlayReason: v.reason,
            overlayDone: v.done,
            // Контроль-8 (job-status-injected): «действие УЖЕ УШЛО» — тот же признак, что у синхронного пути; без него
            // сервер печатал «дальше — нет», и продолжение повторяло ушедший Enter.
            ...(v.injected ? { overlayInjected: true } : {}),
            // Контроль-9 (job-veil-done0-injected-contradiction): при `done=0 && injected` (вуаль поймала САМОЕ ПЕРВОЕ
            // действие в момент инжекции) прежний текст утверждал «уйти ничего не успело» рядом с признаком
            // overlayInjected — и это прямо санкционировало дубль необратимого действия при перезапуске.
            note: v.injected
              ? `задание ОСТАНОВЛЕНО вуалью режима выделения; действие последнего шага УЖЕ УШЛО в GUI — исход НЕ подтверждён${v.done > 0 ? `, а сделанное до него (${v.done}) не откатывается` : ""}`
              : v.done > 0
                ? `задание ОСТАНОВЛЕНО вуалью режима выделения (состояние системы, не ошибка скрипта); сделанное до остановки (${v.done}) не откатывается`
                : "задание ОСТАНОВЛЕНО вуалью режима выделения ДО первого действия — уйти ничего не успело",
          });
        }
        // Контроль-8 (background-caught-exit0): скрипт ПЕРЕХВАТИЛ отказ вуали (голый except ловит SystemExit) и вышел
        // кодом 0 — зеркало синхронного пути (иначе «exitCode: 0» читается успехом при невыполненных действиях).
        if (finished && exitCode === 0 && js.lang === "python" && (veilStderr || "").includes("[overlay_drawing]")) {
          const caught = overlayDrawingFromCodeRun({ exitCode: OVERLAY_EXIT_CODE, stderr: veilStderr, lang: js.lang });
          return okResult(commandId, startedAt, {
            ...js,
            overlayCaught: true,
            overlayReason: caught?.reason ?? "поверх экрана вуаль режима выделения",
            note: "скрипт перехватил отказ вуали режима выделения и продолжил — часть действий НЕ выполнена; исход НЕ подтверждён, сверь состояние",
          });
        }
        return okResult(commandId, startedAt, js);
      }

      // ── skill-runner (tier-0.5, §8): локальное исполнение шагов без LLM ──
      case "skill.execute": {
        const cancel = { cancelled: false }; // TODO(M8): связать с отменой задачи (§20)
        // H5: тот же USER_BUSY-гейт, что в dispatch — навык, запущенный ПРОАКТИВНО (Джарвис сам затеял),
        // не должен инжектить физ.мышь/клаву мимо сторожа. Явный (origin==="user") навык НЕ гейтим.
        const skillProactive = cmd.origin === "proactive" || cmd.proactive === true;
        const outcome = await runSkill({
          skillId: cmd.skillId,
          version: cmd.version,
          steps: cmd.steps,
          params: cmd.params,
          cancel,
          // §Волна3 ревью (#2): реплей САМ укладывается в бюджет и честно возвращается ДО серверного
          // потолка (REPLAY_MACRO_SERVER_TIMEOUT_MS, строго больше) — чтобы сервер не запустил LLM-петлю
          // параллельно ещё идущему на клиенте реплею («два писателя в GUI»). Env — на всякий случай.
          deadlineMs: SKILL_REPLAY_BUDGET_MS,
          actuator: createClientActuator({ isProactive: skillProactive, userActiveNow }),
          // escalate (needs_llm: сочинить значение шага по месту; exhausted: починка) — клиент↔сервер
          // round-trip ещё не подключён (TODO M4+). Пока хук не передаётся → раннер честно ВАЛИТ
          // needsLlm-шаг (не исполняет вслепую с незаполненным плейсхолдером). Детерминированные шаги
          // (в т.ч. со слотами, заполненными сервером в cmd.params) исполняются как прежде, $0/без LLM.
        });
        const skillRes = outcomeToActionResult(commandId, outcome, Date.now() - startedAt);
        // §Волна2 (2.1/2.2): успешный реплей/берст — приложить наблюдение итогового состояния
        // (fused observe): сервер увидит реальный экран в том же tool_result.
        if (skillRes.ok) {
          // Контроль-6 (C5R-8): вуаль судится по окну НАБЛЮДЕНИЯ, а не всего реплея (до 90 с) — как WaitOutcome.veiled.
          const tObs = Date.now();
          const observation = await observeAfterAction({ settleMs: 400, before: beforeUi });
          if (observation) {
            skillRes.data = { observation, ...(selectionStore.drawing || selectionStore.drawingEndedAfter(tObs) ? { veiled: true } : {}) };
          }
        }
        return skillRes;
      }
      case "fs.view": {
        // §3.9 зрение на файл: картинка/страница PDF с диска → base64 для vision (тип — по сигнатуре;
        // не декодировалось/нечем отрендерить/секрет → исключение → error.runtime, не пустая картинка).
        const out = await viewFile(cmd.path, { page: cmd.page, maxSide: cmd.maxSide });
        return okResult(commandId, startedAt, out);
      }
      case "screen.capture":
        // Зрение (§): снять активный монитор (под курсором) / выбранный → base64 PNG в ActionResult.data.
        // §Волна2 (2.3): rect/scale — кроп региона (~50-200 ток) вместо полного кадра.
        return okResult(
          commandId,
          startedAt,
          await captureScreen(cmd.monitor, {
            rect: cmd.rect as CaptureRect | undefined,
            scale: cmd.scale,
          }),
        );
      case "screen.ocr": {
        // §Волна2 (2.3): локальный OCR (Windows.Media.Ocr в сайдкаре) — текст с экрана без vision-раунда.
        const ocr = await screenOcr(cmd.monitor, cmd.rect as CaptureRect | undefined, cmd.lang);
        return okResult(commandId, startedAt, ocr);
      }
      case "screen.probe": {
        // §Волна2 (2.3): $0-проба «изменилось ли» — перцептивный хеш региона (НЕ доказательство успеха).
        return okResult(commandId, startedAt, await probeScreen(cmd.monitor, cmd.rect as CaptureRect | undefined));
      }
      case "screen.selection": {
        // §режим выделения (2026-09-03): владелец обвёл кусок экрана и говорит о нём «вот тут».
        // view отдаёт СВЕЖИЙ кадр области (не память о ней); нет выделения → честная ошибка из актуатора.
        if (cmd.op === "start") return okResult(commandId, startedAt, await selectionStart(cmd.waitMs, { force: cmd.force === true }));
        // force у clear = голосовая команда владельца (tier0): закрытие вуали — его рука, не «система».
        if (cmd.op === "clear") return okResult(commandId, startedAt, selectionClear({ byOwner: cmd.force === true }));
        return okResult(commandId, startedAt, await selectionView(cmd.scale));
      }
      case "wait.for": {
        // §Волна2 (2.3): клиентское ожидание события (UIA/окно/OCR-текст/звук) — без LLM-поллинга.
        // met:false по таймауту — ЧЕСТНЫЙ исход в data (модель решает сама), не ошибка транспорта.
        const w = await waitFor(cmd.condition, cmd.timeoutMs, cmd.pollMs);
        return okResult(commandId, startedAt, w);
      }
      case "context.read": {
        // Дейксис (§19): selection/active_window через сайдкар (TextPattern); screen — vision (позже).
        const text = await ground.readContext(cmd.scope);
        return okResult(commandId, startedAt, { scope: cmd.scope, text });
      }
      case "demo.record":
        return notImplemented(commandId, startedAt, "M4");
      case "message.send": {
        // Гарды §14 (confirm/cadence/idempotency) уже пройдены на сервере; здесь — доставка userbot'ом (§12).
        const out = await messaging.sendMessage(cmd.channel, cmd.to, cmd.body);
        return okResult(commandId, startedAt, out);
      }
      case "telegram.send": {
        // НЕВИДИМАЯ отправка в Telegram через браузер Джарвиса (off-screen Chrome + CDP, §6).
        // НЕ MTProto/userbot (см. message.send) — реальный webK в скрытом окне. hint — опытная память.
        const out = await jarvisBrowser().telegramSend(cmd.to, cmd.text, { preferredTitle: cmd.preferredTitle, hintPeerId: cmd.hintPeerId });
        return okResult(commandId, startedAt, out);
      }
      case "telegram.read": {
        const out = await jarvisBrowser().telegramRead(cmd.to, cmd.count, { preferredTitle: cmd.preferredTitle, hintPeerId: cmd.hintPeerId });
        return okResult(commandId, startedAt, out);
      }
      // «Браузер Джарвиса» (§6): общие невидимые примитивы над его залогиненным профилем.
      case "jbrowser.open": {
        const out = await jarvisBrowser().open(cmd.url);
        return okResult(commandId, startedAt, out);
      }
      case "jbrowser.read": {
        const out = await jarvisBrowser().read();
        return okResult(commandId, startedAt, out);
      }
      case "jbrowser.inspect": {
        const out = await jarvisBrowser().inspect(cmd.query ?? "", cmd.cap ?? 60);
        return okResult(commandId, startedAt, out);
      }
      case "jbrowser.act": {
        const out = await jarvisBrowser().act(cmd.intent, cmd.params);
        return okResult(commandId, startedAt, out);
      }
      case "jbrowser.login": {
        // Не залогинен на сервисе → открыть его страницу ВИДИМО (тот же профиль), пользователь
        // входит один раз, дальше Джарвис действует невидимо (§6, общий слой логина).
        await jarvisBrowser().openLogin(cmd.url);
        return okResult(commandId, startedAt, { opened: cmd.url });
      }
      case "jbrowser.import_cookies": {
        // §перенос логинов: куки из расширения (расшифрованные, минуя ABE) → CDP setCookie в браузер Джарвиса.
        const out = await jarvisBrowser().importCookies(cmd.cookies as unknown as Parameters<ReturnType<typeof jarvisBrowser>["importCookies"]>[0]);
        return okResult(commandId, startedAt, out);
      }
      case "order.place": {
        // Гарды §14 пройдены на сервере; здесь — browser-автоматизация без ввода карты (§0).
        const out = await browser.placeOrder({ vendor: cmd.vendor, items: cmd.items, total: cmd.total });
        return okResult(commandId, startedAt, out);
      }

      // ── Файловая система (§6): прямое управление файлами ──────
      case "fs.read":
        return okResult(commandId, startedAt, await fs.readFile(cmd.path, cmd.maxBytes, { offset: cmd.offset, lines: cmd.lines, tail: cmd.tail }));
      case "fs.write":
        return okResult(commandId, startedAt, await fs.writeFile(cmd.path, cmd.content, cmd.createDirs));
      case "fs.edit":
        return okResult(commandId, startedAt, await fs.editFile(cmd.path, cmd.old, cmd.new, cmd.replaceAll));
      case "fs.append":
        return okResult(commandId, startedAt, await fs.appendFile(cmd.path, cmd.content));
      case "fs.list":
        return okResult(commandId, startedAt, await fs.listDir(cmd.path, cmd.recursive));
      case "fs.delete":
        // Необратимо: confirm уже взят на сервере (§4); здесь — исполнение.
        return okResult(commandId, startedAt, await fs.deleteEntry(cmd.path, cmd.recursive));
      case "fs.move":
        return okResult(commandId, startedAt, await fs.moveEntry(cmd.from, cmd.to));
      case "fs.mkdir":
        return okResult(commandId, startedAt, await fs.makeDir(cmd.path));
      case "fs.search":
        return okResult(commandId, startedAt, await fs.search(cmd.root, cmd.query, cmd.inContent, cmd.maxResults, Array.isArray(cmd.ignore) ? { ignore: cmd.ignore.map(String) } : undefined));

      // ── Системное управление (§6): питание/блокировка/медиа/громкость/буфер ──
      case "system.lock":
      case "system.power":
      case "system.media":
      case "system.volume":
      case "system.clipboard":
      case "system.layout":
        return okResult(commandId, startedAt, await system.runSystem(cmd));

      // ── Office как живые приложения (§6): Word/Excel через COM ──
      case "office.excel":
        return okResult(commandId, startedAt, await office.runExcel(cmd));
      case "office.word":
        return okResult(commandId, startedAt, await office.runWord(cmd));

      // ── OBS Studio через obs-websocket v5 (§): программное управление вместо кликов ──
      case "obs.request":
        return okResult(commandId, startedAt, await obs.request(cmd.requestType, cmd.requestData));

      // ── Мультимонитор (§6): куда уводить видимую активность Джарвиса ──
      case "monitor.set": {
        monitors.setTarget(cmd.target);
        return okResult(commandId, startedAt, { target: cmd.target, summary: monitors.summary() });
      }
      case "monitor.list": {
        return okResult(commandId, startedAt, monitors.monitorList());
      }
      case "monitor.assign": {
        const list = monitors.monitorList();
        if (cmd.index !== null && (cmd.index < 0 || cmd.index >= list.monitors.length)) {
          // честный провал: индекс вне диапазона (а не молчаливое игнорирование)
          throw new Error(`нет монитора с номером ${cmd.index + 1} — всего мониторов ${list.monitors.length}`);
        }
        monitors.setJarvisIndex(cmd.index);
        return okResult(commandId, startedAt, monitors.monitorList());
      }

      default: {
        // Исчерпывающая проверка union: при добавлении нового kind тут будет ошибка типа.
        const _exhaustive: never = cmd;
        return errResult(commandId, startedAt, "runtime", `unknown kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (e) {
    // §режим выделения: гейт точки инжекции бросил — это состояние системы (вуаль), не сбой актуатора.
    if (e instanceof DrawingOverlayError) {
      // Контроль-6 (C5R-2): «ушло, исход не подтверждён» — отдельный признак (сервер: overlayActionInjected).
      return { ...errResult(commandId, startedAt, "overlay_drawing", e.message), ...(e.injected ? { stepActionInjected: true } : {}) };
    }
    // W4: часть act ушла в GUI (клик в поле прошёл, печать упала) — ошибка, но с признаком «ушло»: сервер
    // помечает исход неизвестным, чтобы «доделай» не повторило действие вслепую.
    if (e instanceof ActPartialError) return { ...errResult(commandId, startedAt, "runtime", e.message), stepActionInjected: true };
    const message = e instanceof Error ? e.message : String(e);
    log.error(`actuator ${cmd.kind} упал: ${message}`);
    // NotImplementedError из стабов — это тоже runtime-ошибка наружу (честно).
    return errResult(commandId, startedAt, "runtime", message);
  }
}
