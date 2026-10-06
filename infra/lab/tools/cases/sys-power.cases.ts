/**
 * Кейсы питания и сессии: system_power (§14: shutdown/restart/logoff — ТОЛЬКО с «да»; sleep/cancel — без вопроса по схеме),
 * system_lock и system_layout (обратимы, вопроса нет по замыслу: asked:0 — не дефект). Реальный ПК не выключается:
 * «ПК» лаборатории только пишет эффект и состояние. shutdown/restart — ВСЕГДА отложенно (окно отмены), не мгновенно.
 */
import type { CaseStep, EffectCheck, ToolCase } from "../case-format.js";
import { deskLab, yesIf } from "./sys-fixtures.js";

const noPower: EffectCheck[] = [{ none: "system.power" }];
const SHUT: CaseStep = { tool: "system_power", args: { op: "shutdown" }, confirm: "yes" };
const delayed = (op: string, what: string): EffectCheck[] => [
  { has: "system.power", detail: { op, delaySec: 25, warning: `Джарвис: ${what} через 25 сек. Передумали — скажите «отмена».` } },
  (fx) => fx.every((e) => e.detail.immediate !== true) || "выключение/перезагрузка мгновенные, без окна отмены",
];

export const cases: ToolCase[] = [
  // ───────────── system_power ─────────────
  {
    tool: "system_power", name: "shutdown + «да»: вопрос назвал операцию, выключение ОТЛОЖЕНО на 25 с с предупреждением (не мгновенно)",
    args: { op: "shutdown" }, confirm: yesIf(/Питание: shutdown/),
    expect: { ok: true, asked: 1, actionKinds: ["system.power"], effects: [...delayed("shutdown", "выключение")] }, coversTool: "system_power",
  },
  {
    tool: "system_power", name: "restart + «да»: перезагрузка тоже отложена и с текстом предупреждения",
    args: { op: "restart" }, confirm: "yes", expect: { ok: true, asked: 1, effects: [...delayed("restart", "перезагрузка")] }, coversTool: "system_power",
  },
  {
    tool: "system_power", name: "logoff + «да»: выход выполняется сразу (окна отмены у ОС нет) — потому и стоит вопрос",
    args: { op: "logoff" }, confirm: "yes", expect: { ok: true, asked: 1, effects: [{ has: "system.power", detail: { op: "logoff", immediate: true } }] }, coversTool: "system_power",
  },
  {
    tool: "system_power", name: "shutdown + «нет»: «Отменено пользователем», клиенту ничего не ушло",
    args: { op: "shutdown" }, confirm: "no",
    expect: { flags: { declined: true, channelDown: false }, asked: 1, actionKinds: [], resultIncludes: /Отменено пользователем/, effects: noPower }, coversTool: "system_power",
  },
  {
    tool: "system_power", name: "shutdown + окно истекло: «не ответили», не приписано «нет» владельца",
    args: { op: "shutdown" }, confirm: "expire",
    expect: { flags: { declined: true, channelDown: false }, asked: 1, actionKinds: [], resultIncludes: /не ответили|истекл/, resultExcludes: /Отменено пользователем/, effects: noPower }, coversTool: "system_power",
  },
  {
    tool: "system_power", name: "restart + вопрос не дошёл: «не смог спросить», channelDown, ничего не выполнено",
    args: { op: "restart" }, confirm: "undelivered",
    expect: { flags: { declined: true, channelDown: true }, asked: 1, actionKinds: [], resultIncludes: /не смог спросить/, resultExcludes: /Отменено пользователем/, effects: noPower }, coversTool: "system_power",
  },
  {
    tool: "system_power", name: "logoff + «нет»: не выходим из сессии",
    args: { op: "logoff" }, confirm: "no", expect: { flags: { declined: true }, asked: 1, actionKinds: [], effects: noPower }, coversTool: "system_power",
  },
  {
    tool: "system_power", name: "нет канала подтверждения — fail-closed: shutdown не выполняется",
    args: { op: "shutdown" }, lab: { ctx: { confirm: undefined } },
    expect: { ok: false, asked: 0, actionKinds: [], resultIncludes: /канал недоступен/, effects: noPower }, coversTool: "system_power",
  },
  {
    tool: "system_power", name: "sleep — без вопроса по схеме (обратимо), эффект sleep выставлен",
    args: { op: "sleep" }, expect: { ok: true, asked: 0, actionKinds: ["system.power"], effects: [{ has: "system.power", detail: { op: "sleep", immediate: true } }] }, coversTool: "system_power",
  },
  {
    tool: "system_power", name: "cancel без запланированного выключения — не ошибка, hadPending:false, без вопроса",
    args: { op: "cancel" }, expect: { ok: true, asked: 0, effects: [{ has: "system.power", detail: { op: "cancel", hadPending: false } }] }, coversTool: "system_power",
  },
  {
    tool: "system_power", name: "cancel после shutdown отменяет ожидающее (hadPending:true) — окно отмены реально работает",
    args: { op: "cancel" }, before: [SHUT], expect: { ok: true, asked: 0, effects: [{ has: "system.power", detail: { op: "cancel", hadPending: true } }] }, coversTool: "system_power",
  },
  {
    tool: "system_power", name: "второй shutdown при уже запланированном — честная ошибка 1190, а не «выключаю»",
    args: { op: "shutdown" }, before: [SHUT], confirm: "yes", expect: { ok: false, asked: 1, actionKinds: ["system.power"], resultIncludes: /1190/, effects: noPower }, coversTool: "system_power",
  },
  {
    tool: "system_power", name: "операция вне enum (hibernate): даже после «да» ничего не выполняется, честная ошибка",
    args: { op: "hibernate" }, confirm: "yes", expect: { ok: false, asked: 1, resultIncludes: /unknown system command/, effects: noPower }, coversTool: "system_power",
  },
  {
    tool: "system_power", name: "клиент упал на sleep — «не удалось», эффекта нет",
    args: { op: "sleep" }, lab: deskLab({ fault: { kind: "system.power", mode: "error" } }), expect: { ok: false, resultIncludes: /не удалось: runtime/, effects: noPower }, coversTool: "system_power",
  },

  // ───────────── system_lock ─────────────
  {
    tool: "system_lock", name: "блокировка без вопроса (по схеме): ПК заблокирован, эффект system.lock",
    args: {}, expect: { ok: true, asked: 0, actionKinds: ["system.lock"], effects: [{ has: "system.lock", detail: { wasLocked: false } }], state: (s) => s.locked || "ПК не заблокирован" }, coversTool: "system_lock",
  },
  {
    tool: "system_lock", name: "повторная блокировка уже заблокированного ПК — успех, wasLocked:true",
    args: {}, before: [{ tool: "system_lock" }], expect: { ok: true, effects: [{ has: "system.lock", detail: { wasLocked: true } }], state: (s) => s.locked || "не заблокирован" }, coversTool: "system_lock",
  },
  {
    tool: "system_lock", name: "клиент упал — «не удалось», ПК НЕ заблокирован",
    args: {}, lab: deskLab({ fault: { kind: "system.lock", mode: "error" } }),
    expect: { ok: false, resultIncludes: /не удалось: runtime/, effects: [{ none: "system.lock" }], state: (s) => !s.locked || "ПК заблокирован вопреки ошибке" }, coversTool: "system_lock",
  },
  {
    tool: "system_lock", name: "клиент молчит (таймаут) — ошибка с причиной timeout, ложного «заблокировано» нет",
    args: {}, lab: deskLab({ fault: { kind: "system.lock", mode: "silent" } }),
    expect: { ok: false, resultIncludes: /timeout/, resultExcludes: /"ok":true/, state: (s) => !s.locked || "заблокирован" }, coversTool: "system_lock",
  },

  // ───────────── system_layout ─────────────
  {
    tool: "system_layout", name: "en: раскладка переключена ru→en, ответ называет фактическую раскладку, вопроса нет",
    args: { lang: "en" }, expect: { ok: true, asked: 0, actionKinds: ["system.layout"], resultIncludes: '"stdout":"en"', effects: [{ has: "system.layout", detail: { from: "ru", to: "en", changed: true } }] }, coversTool: "system_layout",
  },
  {
    tool: "system_layout", name: "ru при уже русской — честный no-op (changed:false), а не «переключил»",
    args: { lang: "ru" }, expect: { ok: true, resultIncludes: '"stdout":"ru"', effects: [{ has: "system.layout", detail: { from: "ru", to: "ru", changed: false } }] }, coversTool: "system_layout",
  },
  {
    tool: "system_layout", name: "toggle после en возвращает ru",
    args: { lang: "toggle" }, before: [{ tool: "system_layout", args: { lang: "en" } }], expect: { ok: true, resultIncludes: '"stdout":"ru"', effects: [{ has: "system.layout", detail: { from: "en", to: "ru", changed: true } }] }, coversTool: "system_layout",
  },
  {
    tool: "system_layout", name: "раскладка меняется у ПЕРЕДНЕГО окна (игры/чата), hwnd в эффекте = окно на переднем плане",
    args: { lang: "en" }, seed: { windows: [{ title: "Dota 2", process: "dota2" }] },
    expect: { ok: true, effects: [(fx, s) => fx.find((e) => e.kind === "system.layout")?.detail.hwnd === s.foregroundHwnd || "hwnd эффекта не равен переднему окну"] }, coversTool: "system_layout",
  },
  {
    tool: "system_layout", name: "неизвестный язык (de) — честная ошибка, раскладка не тронута",
    args: { lang: "de" }, expect: { ok: false, resultIncludes: /unknown system command/, effects: [{ none: "system.layout" }] }, coversTool: "system_layout",
  },
  {
    tool: "system_layout", name: "клиент упал — «не удалось», эффекта переключения нет",
    args: { lang: "en" }, lab: deskLab({ fault: { kind: "system.layout", mode: "error" } }), expect: { ok: false, resultIncludes: /не удалось: runtime/, effects: [{ none: "system.layout" }] }, coversTool: "system_layout",
  },
];
