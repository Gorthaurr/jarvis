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
import type { ActionCommand } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import { type FoundTarget, findTarget } from "./act-find.js";
import { type ActDone, performAct } from "./act-do.js";
import { type ActVerdict, verifyOutcome } from "./act-verify.js";
import { focusApp } from "./apps.js";
import { captureUiFingerprint } from "./observe.js";
import { focusWindow } from "./windows.js";

const log = createLogger("actuator:act");

/** Клиентский бюджет всего примитива (см. шапку и protocol/constants.ts: серверный потолок 60 с). */
export const ACT_BUDGET_MS = 45_000;

export type ActCommand = Extract<ActionCommand, { kind: "gui.act" }>;

/** Ответ модели: что нашли, что сделали, подтверждён ли исход. Наблюдение — в том же формате, что у input_click. */
export interface ActOutcome extends Pick<ActDone, "screenX" | "screenY" | "physical">, Pick<ActVerdict, "verified" | "detail" | "observation"> {
  found?: Pick<FoundTarget, "via" | "name" | "role" | "handle" | "note">;
  did: string;
  /** Окно, которое сфокусировали по app (заголовок) — факт, не claim. */
  focused?: string;
}

/** Сфокусировать окно по подстроке: сайдкар (честный readback) → AppActivate; не вышло → ошибка ДО действия. */
async function focusAppWindow(app: string): Promise<string> {
  let title = "";
  let sidecarErr = "";
  try {
    const r = await focusWindow({ query: app });
    if (r.focused) return r.title || app;
    title = r.title;
  } catch (e) {
    sidecarErr = e instanceof Error ? e.message : String(e);
  }
  const legacy = await focusApp(app);
  if (legacy.focused) return title || app;
  throw new Error(
    title
      ? `окно «${title}» найдено, но фокус не перешёл (foreground-lock) — ничего не нажато.`
      : `окно «${app}» не найдено (${sidecarErr || "нет среди открытых"}) — ничего не нажато. Проверь имя через window_list или запусти программу.`,
  );
}

/** Проверка аргументов ДО любого действия: неверная форма — честная ошибка, а не клик наугад. */
function validate(cmd: ActCommand): void {
  const verb = cmd.do ?? "click";
  if (verb === "key" && !cmd.combo?.trim()) throw new Error("act do:key без combo");
  if ((verb === "type" || verb === "set") && !cmd.text) throw new Error(`act do:${verb} без text`);
  if (verb !== "key" && cmd.target === undefined) throw new Error(`act do:${verb} без target`);
}

export async function act(cmd: ActCommand, opts: { restoreCursor: boolean }): Promise<ActOutcome> {
  validate(cmd);
  const deadline = Date.now() + ACT_BUDGET_MS;
  const verb = cmd.do ?? "click";
  const focused = cmd.app?.trim() ? await focusAppWindow(cmd.app.trim()) : undefined;
  const found = cmd.target !== undefined ? await findTarget(cmd.target, deadline) : undefined;
  log.info("act", { verb, via: found?.via, name: found?.name, app: focused });
  // Снимок «до» — база дельты; на UIA-слепом окне OCR той же области, что и «после» (нужна точка).
  const before = await captureUiFingerprint(found?.point);
  const done = await performAct(found, verb, { text: cmd.text, combo: cmd.combo, physical: cmd.physical, restoreCursor: opts.restoreCursor });
  const clickPoint = found?.point ?? (done.screenX !== undefined && done.screenY !== undefined ? { x: done.screenX, y: done.screenY } : undefined);
  const verdict = await verifyOutcome(cmd.verify, { before, clickPoint, deadline });
  return {
    ...(found ? { found: { via: found.via, name: found.name, role: found.role, handle: found.handle, note: found.note } } : {}),
    ...(focused ? { focused } : {}),
    did: done.did,
    physical: done.physical,
    screenX: done.screenX,
    screenY: done.screenY,
    verified: verdict.verified,
    detail: verdict.detail,
    observation: verdict.observation,
  };
}
