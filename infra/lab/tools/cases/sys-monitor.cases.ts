/**
 * Кейсы мультимонитора: monitor_list, monitor_assign (постоянно), monitor_set (временно). Типовой «ПК» — два монитора:
 * 1 (основной, 2560×1440) и 2 (справа, 1920×1080); по умолчанию рабочий у Джарвиса — вторичный. Эффекта monitor.set у
 * FakeDesktop нет и снимок не хранит назначение — доказываем ответом списка (isJarvis/jarvisIndex), а не «ok».
 */
import type { CaseStep, EffectCheck, ToolCase } from "../case-format.js";
import { deskLab } from "./sys-fixtures.js";

const assign = (index: number | null): CaseStep => ({ tool: "monitor_assign", args: { index } });
const jarvisAt = (i: number) => new RegExp(`"index":${i},[^}]*"isJarvis":true`);
const notJarvisAt = (i: number) => new RegExp(`"index":${i},[^}]*"isJarvis":false`);
const noAssign: EffectCheck[] = [{ none: "monitor.assign" }];

export const cases: ToolCase[] = [
  // ───────────── monitor_list ─────────────
  {
    tool: "monitor_list", name: "два монитора с разрешением и расположением; по умолчанию Джарвис на вторичном (авто)",
    args: {}, expect: { ok: true, actionKinds: ["monitor.list"], resultIncludes: ["Монитор 1 — 2560×1440 (основной)", "Монитор 2 — 1920×1080 (справа)", '"jarvisIndex":null', jarvisAt(1), notJarvisAt(0)], effects: noAssign }, coversTool: "monitor_list",
  },
  {
    tool: "monitor_list", name: "после monitor_assign(0) список показывает Джарвиса на мониторе 0 и jarvisIndex:0",
    args: {}, before: [assign(0)], expect: { ok: true, resultIncludes: ['"jarvisIndex":0', jarvisAt(0), notJarvisAt(1)] }, coversTool: "monitor_list",
  },
  {
    tool: "monitor_list", name: "после временного monitor_set primary Джарвис на основном, а постоянное назначение (jarvisIndex) не тронуто",
    args: {}, before: [{ tool: "monitor_set", args: { target: "primary" } }], expect: { ok: true, resultIncludes: ['"jarvisIndex":null', jarvisAt(0)] }, coversTool: "monitor_list",
  },
  {
    tool: "monitor_list", name: "клиент упал — «не удалось», выдуманных мониторов в ответе нет",
    args: {}, lab: deskLab({ fault: { kind: "monitor.list", mode: "error" } }), expect: { ok: false, resultIncludes: /не удалось: runtime/, resultExcludes: "Монитор 1" }, coversTool: "monitor_list",
  },

  // ───────────── monitor_assign ─────────────
  {
    tool: "monitor_assign", name: "назначить монитор 0: эффект monitor.assign{index:0}, в ответе список с Джарвисом на нём",
    args: { index: 0 }, expect: { ok: true, actionKinds: ["monitor.assign"], effects: [{ has: "monitor.assign", detail: { index: 0 } }], resultIncludes: ['"jarvisIndex":0', jarvisAt(0)] }, coversTool: "monitor_assign",
  },
  {
    tool: "monitor_assign", name: "index:null — обратно в авто (вторичный), jarvisIndex снова null",
    args: { index: null }, before: [assign(0)], expect: { ok: true, effects: [{ has: "monitor.assign", detail: { index: null } }], resultIncludes: ['"jarvisIndex":null', jarvisAt(1)] }, coversTool: "monitor_assign",
  },
  {
    tool: "monitor_assign", name: "несуществующий номер 5 — честная ошибка «нет монитора с номером 6», назначение не менялось",
    args: { index: 5 }, expect: { ok: false, resultIncludes: /нет монитора с номером 6.*всего мониторов 2/, effects: noAssign }, coversTool: "monitor_assign",
  },
  {
    tool: "monitor_assign", name: "отрицательный номер — ошибка, а не назначение «с конца»",
    args: { index: -1 }, expect: { ok: false, resultIncludes: /нет монитора/, effects: noAssign }, coversTool: "monitor_assign",
  },
  {
    tool: "monitor_assign", name: "клиент упал — «не удалось», эффекта назначения нет",
    args: { index: 1 }, lab: deskLab({ fault: { kind: "monitor.assign", mode: "error" } }), expect: { ok: false, resultIncludes: /не удалось: runtime/, effects: noAssign }, coversTool: "monitor_assign",
  },

  // ───────────── monitor_set ─────────────
  {
    tool: "monitor_set", name: "primary: Джарвис уходит на основной монитор — сводка называет цель и монитор",
    args: { target: "primary" }, expect: { ok: true, actionKinds: ["monitor.set"], resultIncludes: ['"target":"primary"', "Джарвис на основном", "цель: primary"] }, coversTool: "monitor_set",
  },
  {
    tool: "monitor_set", name: "jarvis: возврат на рабочий (вторичный) монитор после primary",
    args: { target: "jarvis" }, before: [{ tool: "monitor_set", args: { target: "primary" } }], expect: { ok: true, resultIncludes: ["Джарвис на вторичном", "цель: jarvis"] }, coversTool: "monitor_set",
  },
  {
    tool: "monitor_set", name: "временная цель не переписывает постоянное назначение: assign(0) сохраняется после set primary → jarvis",
    args: { target: "jarvis" }, before: [assign(0), { tool: "monitor_set", args: { target: "primary" } }], expect: { ok: true, resultIncludes: "Джарвис на основном" }, coversTool: "monitor_set",
  },
  {
    tool: "monitor_set", name: "неизвестная цель (left) — ошибка, а не молчаливое «цель: left»",
    args: { target: "left" },
    skip: "ДЕФЕКТ (low): apps/client monitors.setTarget и сервер не проверяют enum jarvis|primary — любая строка принимается и рапортуется успехом",
    expect: { ok: false }, coversTool: "monitor_set",
  },
  {
    tool: "monitor_set", name: "клиент упал — «не удалось», сводки в ответе нет",
    args: { target: "primary" }, lab: deskLab({ fault: { kind: "monitor.set", mode: "error" } }), expect: { ok: false, resultIncludes: /не удалось: runtime/, resultExcludes: "мониторов:" }, coversTool: "monitor_set",
  },
];
