/**
 * W4 «Руки» (2026-09-10, ревью §7): ОДИН примитив gui.act — «нажми «Отправить» в Telegram».
 *
 * Оркестратор: [фокус окна app] → поиск цели (act-find: handle → точка → снапшот UIA → OCR) → снимок структуры
 * ДО → действие (act-do) → сверка (act-verify: дельта ПОСЛЕ + ожидание признака). Всё — внутри одного вызова
 * инструмента, без раундов модели между ступенями (форензика: пара «screen_capture → input_click» была самой
 * частой в истории, а лестница восприятия в персоне не применялась).
 *
 * Честность: окно app не найдено → ошибка ДО любого действия; цель не найдена/неоднозначна → ошибка со списком
 * видимого; действие ушло, признак не наступил → verified:"failed" (не «не сделано» и без повтора); сенсор не
 * смог ответить → "unchecked". Снимок «до» снимается ПОСЛЕ фокуса и поиска — до них передний план другой.
 *
 * БЮДЖЕТ: ACT_BUDGET_MS < серверного actionTimeoutMs("gui.act") (protocol/constants.ts) с запасом на транспорт —
 * иначе успешное действие рапортовалось бы таймаутом и ретрай модели ПОВТОРИЛ бы клик. Поднимаешь одно —
 * пересчитай другое.
 */
import { createLogger } from "@jarvis/shared";
import { type ActCommand, validateAct } from "./act-args.js";
import { type FoundTarget, findTarget } from "./act-find.js";
import { type ActDone, performAct } from "./act-do.js";
import { type ActVerdict, precheckVerify, verifyOutcome } from "./act-verify.js";
import { focusApp } from "./apps.js";
import { withExpectedForeground } from "./approval-scope.js";
import { preflightKeys, preflightText } from "./injection-guard.js";
import { captureUiFingerprint } from "./observe.js";
import { PASTE_FROM_CHARS } from "./paste-text.js";
import { focusWindow } from "./windows.js";

const log = createLogger("actuator:act");

/** Клиентский бюджет всего примитива (см. шапку и protocol/constants.ts: серверный потолок 60 с). */
export const ACT_BUDGET_MS = 45_000;

export type { ActCommand };

/** Ответ модели: что нашли, что сделали, подтверждён ли исход. Наблюдение — в том же формате, что у input_click. */
export interface ActOutcome extends Pick<ActDone, "screenX" | "screenY" | "physical">, Pick<ActVerdict, "verified" | "detail" | "observation"> {
  found?: Pick<FoundTarget, "via" | "name" | "role" | "handle" | "note" | "query">;
  did: string;
  /** Окно, которое сфокусировали по app (заголовок) — факт, не claim. */
  focused?: string;
}

/**
 * Сфокусировать окно по подстроке: сайдкар (честный readback) → AppActivate; не вышло → ошибка ДО действия.
 * W2: + hwnd окна (П1: expectedForeground/G-11, поиск цели в окне app); у AppActivate-пути hwnd неизвестен.
 */
async function focusAppWindow(app: string): Promise<{ title: string; hwnd?: number }> {
  let title = "";
  let sidecarErr = "";
  try {
    const r = await focusWindow({ query: app });
    if (r.focused) return { title: r.title || app, ...(r.hwnd ? { hwnd: r.hwnd } : {}) };
    title = r.title;
  } catch (e) {
    sidecarErr = e instanceof Error ? e.message : String(e);
  }
  const legacy = await focusApp(app);
  if (legacy.focused) return { title: title || app };
  throw new Error(
    title
      ? `окно «${title}» найдено, но фокус не перешёл (foreground-lock) — ничего не нажато.`
      : `окно «${app}» не найдено (${sidecarErr || "нет среди открытых"}) — ничего не нажато. Проверь имя через window_list или запусти программу.`,
  );
}

/**
 * G-9 (П1): РАННЯЯ проверка клавишных намерений — сразу после поиска цели, ДО первой инжекции (клика в поле):
 * «привет\n» в Telegram без гранта = ни клика, ни буквы. Клики судит рубеж на первой же инжекции.
 * Длинный текст идёт вставкой (act-do, H-T1) — перевод строки в ней не Enter.
 */
async function earlyKeyCheck(cmd: ActCommand): Promise<void> {
  const verb = cmd.do ?? "click";
  if (verb === "key" && cmd.combo) await preflightKeys([cmd.combo]);
  if (verb === "type" && cmd.text && cmd.text.length < PASTE_FROM_CHARS && /[\r\n]/u.test(cmd.text)) await preflightText(cmd.text);
  if (cmd.enter === true) await preflightKeys(["Enter"]); // П4: Enter после печати — тот же рубеж, но до первой буквы
}

export async function act(cmd: ActCommand, opts: { restoreCursor: boolean }): Promise<ActOutcome> {
  validateAct(cmd);
  const deadline = Date.now() + ACT_BUDGET_MS;
  const win = cmd.app?.trim() ? await focusAppWindow(cmd.app.trim()) : undefined;
  // G-11 (П1): окно app известно по hwnd — вся клавиатура act уходит только в него (рубеж сверяет живой передний план).
  const run = (): Promise<ActOutcome> => actIn(cmd, opts, deadline, win);
  return win?.hwnd ? withExpectedForeground({ hwnd: win.hwnd, title: win.title }, run) : run();
}

async function actIn(cmd: ActCommand, opts: { restoreCursor: boolean }, deadline: number, win: { title: string; hwnd?: number } | undefined): Promise<ActOutcome> {
  const found = cmd.target !== undefined ? await findTarget(cmd.target, deadline, { hwnd: win?.hwnd }) : undefined;
  log.info("act", { verb: cmd.do ?? "click", via: found?.via, name: found?.name, app: win?.title });
  await earlyKeyCheck(cmd);
  // W2: observe:false (промежуточный шаг act{steps}) — без снимков до/после; сверка — признак verify или следующий шаг.
  const observe = cmd.observe !== false;
  // Снимок «до» — база дельты; на UIA-слепом окне OCR той же области, что и «после» (нужна точка).
  const before = observe ? await captureUiFingerprint(found?.point) : undefined;
  const preMet = await precheckVerify(cmd.verify, deadline); // H-V1: признак, видимый ДО действия, исход не доказывает
  // §14 (W2): коммит судит рубеж инжекции по НАЙДЕННОМУ элементу и реальному процессу; одобрение — гранты области.
  const done = await performAct(found, cmd, { restoreCursor: opts.restoreCursor });
  const clickPoint = found?.point ?? (done.screenX !== undefined && done.screenY !== undefined ? { x: done.screenX, y: done.screenY } : undefined);
  const verdict = await verifyOutcome(cmd.verify, { before, clickPoint, deadline, preMet, observe });
  return {
    ...(found ? { found: { via: found.via, name: found.name, role: found.role, handle: found.handle, note: found.note, ...(found.query ? { query: found.query } : {}) } } : {}),
    ...(win ? { focused: win.title } : {}),
    did: done.did,
    physical: done.physical,
    screenX: done.screenX,
    screenY: done.screenY,
    verified: verdict.verified,
    detail: verdict.detail,
    observation: verdict.observation,
  };
}
