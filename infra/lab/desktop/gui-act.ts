import { doVerb } from "./gui-act-actions.js";
/**
 * gui.act: [фокус окна app] → поиск цели (gui-act-find) → снимок «до» → действие → сверка. Три исхода сверки:
 * met (признак наступил) / failed (действие ушло, признак нет — НЕ «не сделано», повтор = дубль) / unchecked (нечем
 * сверить). Повтор разрешён только если ничего не ушло: ошибка ПОСЛЕ инжекции помечается `injected` (stepActionInjected).
 */
import type { ActionCommand, ActVerify, WaitCondition } from "@jarvis/protocol";
import type { DesktopWindow } from "../lib/contracts.js";
import { type Found, findTarget } from "./gui-act-find.js";
import { matchesProcess } from "./gui-apps.js";
import { type Scope, judge } from "./gui-guard.js";
import { veilGate } from "./gui-input.js";
import type { Ctx } from "./gui-model.js";
import { ActionError, foregroundWindow, raise, tick, zOrder } from "./gui-state.js";
import { type Fingerprint, fingerprint, observe } from "./gui-tree.js";
import type { makeWaiter } from "./gui-wait.js";

export type ActCmd = Extract<ActionCommand, { kind: "gui.act" }>;
export const ACT_BUDGET_MS = 45_000;
const VERIFY_DEFAULT = 4000;
const VERIFY_MAX = 15_000;
const VERIFY_MIN = 500;
const VERIFY_POLL = 700;
const PASTE_FROM = 80;
const PHYSICAL_VERBS = new Set(["key", "type", "double", "right", "triple", "middle", "hover", "drag", "scroll"]);
const TICKS = 100;

export function validateAct(cmd: ActCmd): void {
  const verb = cmd.do ?? "click";
  const ticksOk = (v: unknown): boolean => v === undefined || (Number.isInteger(v) && Math.abs(v as number) <= TICKS);
  if (verb === "key" && !cmd.combo?.trim()) throw new ActionError("act do:key без combo", "runtime");
  if ((verb === "type" || verb === "set") && !cmd.text) throw new ActionError(`act do:${verb} без text`, "runtime");
  if (verb !== "key" && verb !== "type" && cmd.target === undefined) throw new ActionError(`act do:${verb} без target`, "runtime");
  if ((cmd.clear === true || cmd.enter === true) && verb !== "type") throw new ActionError(`act ${cmd.clear === true ? "clear" : "enter"}:true — только с do:"type" (ничего не нажато)`, "runtime");
  if (cmd.clear === true && cmd.target === undefined) throw new ActionError("act clear:true без target — укажи поле (роль проверяется до очистки); ничего не нажато", "runtime");
  if (cmd.to !== undefined && verb !== "drag") throw new ActionError('act to — только с do:"drag" (ничего не нажато)', "runtime");
  if (verb === "drag" && cmd.to === undefined) throw new ActionError("act do:drag без to — куда тащить", "runtime");
  if ((cmd.dx !== undefined || cmd.dy !== undefined) && verb !== "scroll") throw new ActionError('act dx/dy — только с do:"scroll" (ничего не нажато)', "runtime");
  if (verb === "scroll") {
    if (!ticksOk(cmd.dx) || !ticksOk(cmd.dy)) throw new ActionError(`act do:scroll: dx/dy — целые тики, не больше ${TICKS} по модулю`, "runtime");
    if (!cmd.dx && !cmd.dy) throw new ActionError("act do:scroll без dy/dx — сколько тиков крутить (+вверх/−вниз)", "runtime");
  }
}

export function verifyCondition(v: ActVerify): WaitCondition | null {
  const gone = v.gone === true;
  if (v.text?.trim()) return { kind: "text", text: v.text.trim(), monitor: "active", gone };
  if (v.element?.role?.trim()) return { kind: "ui", role: v.element.role.trim(), name: v.element.name?.trim() || undefined, nameMode: "substring", gone };
  if (v.title?.trim()) return { kind: "window", titleContains: v.title.trim(), gone };
  return null;
}

const describe = (v: ActVerify): string => {
  const what = v.text ? `текст «${v.text}»` : v.element ? `элемент ${v.element.role}${v.element.name ? ` «${v.element.name}»` : ""}` : `окно «${v.title ?? ""}»`;
  return v.gone ? `исчезновение: ${what}` : what;
};

export interface ActOutcome {
  found?: Pick<Found, "via" | "name" | "role" | "handle" | "note" | "query">;
  focused?: string;
  did: string;
  physical: boolean;
  screenX?: number;
  screenY?: number;
  verified: "met" | "failed" | "unchecked";
  detail: string;
  observation?: ReturnType<typeof observe>;
}

/** Окно app: подстрока заголовка/процесса или имя приложения; свёрнутое восстанавливается. Нет — ошибка ДО любого действия. */
function focusAppWindow(ctx: Ctx, app: string): DesktopWindow {
  const q = app.trim().toLowerCase();
  const w = zOrder(ctx.core, ctx.st).find((x) => x.title.toLowerCase().includes(q) || x.process.toLowerCase().includes(q) || matchesProcess(x.process, app));
  if (!w) throw new ActionError(`окно «${app}» не найдено (нет среди открытых) — ничего не нажато. Проверь имя через window_list или запусти программу.`, "runtime");
  raise(ctx.core, ctx.st, w);
  ctx.core.effect("window.focus", { hwnd: w.hwnd, title: w.title, process: w.process, via: "gui.act" });
  return w;
}

export function makeAct(waitFor: ReturnType<typeof makeWaiter>) {
  return async function act(ctx: Ctx, cmd: ActCmd, scope: Scope): Promise<ActOutcome> {
    validateAct(cmd);
    const { core } = ctx;
    const verb = cmd.do ?? "click";
    if (cmd.physical === true || cmd.app?.trim() || PHYSICAL_VERBS.has(verb)) veilGate(ctx, cmd.app?.trim() ? "Смена фокуса окна отобрала бы клавиатуру у окна рисования." : "");
    const deadline = core.now() + ACT_BUDGET_MS;
    const win = cmd.app?.trim() ? focusAppWindow(ctx, cmd.app.trim()) : undefined;
    const fg = foregroundWindow(core);
    const found = cmd.target !== undefined ? findTarget(ctx, cmd.target, win, win ?? fg) : undefined;
    // Ранняя проверка клавишных намерений ДО первого клика: «привет\n» в Telegram без гранта = ни клика, ни буквы.
    const target = win ?? fg;
    const early = (combo: string): void => judge(scope, [{ op: "key", params: { combo, mode: "press" }, w: target }], true);
    if (verb === "key" && cmd.combo) early(cmd.combo);
    if (verb === "type" && cmd.text && cmd.text.length < PASTE_FROM && /[\r\n]/u.test(cmd.text)) judge(scope, [{ op: "type", params: { text: cmd.text }, w: target }], true);
    if (cmd.enter === true) early("Enter");
    const observeOn = cmd.observe !== false;
    const before: Fingerprint | undefined = observeOn ? fingerprint(ctx, target) : undefined;
    const cond = cmd.verify ? verifyCondition(cmd.verify) : null;
    let preMet = false;
    if (cond && deadline - core.now() >= VERIFY_MIN * 4) {
      const r = await waitFor(ctx, cond, VERIFY_MIN, VERIFY_POLL);
      preMet = r.met && r.unknown !== true;
    }
    const done = await doVerb(ctx, found, cmd, scope, (to) => findTarget(ctx, to, win, win ?? fg));
    tick(core, 350);
    const observation = observeOn ? observe(ctx, before) : undefined;
    let verified: ActOutcome["verified"] = "unchecked";
    let detail: string;
    if (!cond) {
      detail = !cmd.verify
        ? observation && observation.changed
          ? "признак verify не задан — суди по дельте наблюдения ниже"
          : "признак verify не задан, наблюдение слабое или недоступно — исход НЕ подтверждён, сверь глазами"
        : "verify без признака (нужен text / element / title) — исход не сверен";
    } else {
      const want = Math.min(VERIFY_MAX, Math.max(VERIFY_MIN, cmd.verify?.timeoutMs ?? VERIFY_DEFAULT));
      const left = deadline - core.now();
      if (left < VERIFY_MIN) detail = `на ожидание признака (${describe(cmd.verify!)}) не осталось бюджета — исход не сверен`;
      else {
        const timeout = Math.min(want, left);
        const r = await waitFor(ctx, cond, timeout, VERIFY_POLL);
        const label = describe(cmd.verify!);
        if (r.met && preMet) detail = `признак (${label}) был виден ещё ДО действия — исход он не доказывает; выбери меняющийся признак (новый текст или gone:true)`;
        else if (r.met) {
          verified = "met";
          detail = `признак наступил (${label}) за ${r.elapsedMs} мс: ${r.detail}`;
        } else if (r.unknown) detail = `сенсор не смог проверить признак (${label}): ${r.detail}`;
        else {
          verified = "failed";
          detail = `признак НЕ наступил за ${timeout} мс (${label})${timeout < want ? " — ожидание урезано бюджетом" : ""}: ${r.detail}`;
        }
      }
    }
    return {
      ...(found ? { found: { via: found.via, name: found.name, role: found.role, handle: found.handle, note: found.note, ...(found.query ? { query: found.query } : {}) } } : {}),
      ...(win ? { focused: win.title } : {}),
      did: done.did,
      physical: done.physical,
      screenX: done.screenX,
      screenY: done.screenY,
      verified,
      detail,
      observation,
    };
  };
}

