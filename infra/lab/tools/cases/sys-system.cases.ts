/**
 * Кейсы громкости и буфера обмена: system_volume (readback-сверка, mute — тумблер), system_clipboard (§0: номера карт не
 * кладём, голые коды — с предупреждением). Факт — состояние «ПК» и эффекты. Медиа-клавиши — в sys-media.cases.ts.
 */
import type { ToolCase } from "../case-format.js";
import { INJECTION, deskLab } from "./sys-fixtures.js";

const vol = (n: number) => (s: { volume: number }): boolean | string => s.volume === n || `громкость ${s.volume}, ждали ${n}`;
const clip = (t: string) => (s: { clipboard: string }): boolean | string => s.clipboard === t || `буфер: ${JSON.stringify(s.clipboard)}`;
const TEXT = "строка 1\nстрока 2 🙂";

export const cases: ToolCase[] = [
  // ───────────── system_volume ─────────────
  {
    tool: "system_volume", name: "set 30: уровень по факту 30, эффект несёт было/стало, вопроса нет",
    args: { op: "set", level: 30 }, expect: { ok: true, asked: 0, actionKinds: ["system.volume"], resultIncludes: '"level":30', effects: [{ has: "system.volume", detail: { op: "set", from: 40, level: 30, requested: 30 } }], state: vol(30) }, coversTool: "system_volume",
  },
  {
    tool: "system_volume", name: "get только читает: текущий уровень из «ПК», состояние не менялось",
    args: { op: "get" }, seed: { volume: 55 }, expect: { ok: true, resultIncludes: '"level":55', effects: [{ none: "system.volume" }], state: vol(55) }, coversTool: "system_volume",
  },
  {
    tool: "system_volume", name: "up: +10 от 40 → ровно 50 (readback)",
    args: { op: "up" }, expect: { ok: true, resultIncludes: '"level":50', state: vol(50) }, coversTool: "system_volume",
  },
  {
    tool: "system_volume", name: "up от 95 не превышает 100",
    args: { op: "up" }, seed: { volume: 95 }, expect: { ok: true, resultIncludes: '"level":100', state: vol(100) }, coversTool: "system_volume",
  },
  {
    tool: "system_volume", name: "down от 5 не уходит ниже 0",
    args: { op: "down" }, seed: { volume: 5 }, expect: { ok: true, resultIncludes: '"level":0', state: vol(0) }, coversTool: "system_volume",
  },
  {
    tool: "system_volume", name: "mute — ТУМБЛЕР: звук выключен и ответ говорит muted:true",
    args: { op: "mute" }, expect: { ok: true, resultIncludes: '"muted":true', state: (s) => s.muted || "не заглушено" }, coversTool: "system_volume",
  },
  {
    tool: "system_volume", name: "второй mute снимает заглушку (muted:false) — модель обязана сверять ответ, а не считать «включил»",
    args: { op: "mute" }, before: [{ tool: "system_volume", args: { op: "mute" } }], expect: { ok: true, resultIncludes: '"muted":false', state: (s) => !s.muted || "остался заглушён" }, coversTool: "system_volume",
  },
  {
    tool: "system_volume", name: "set 150 (вне 0..100): ЧЕСТНАЯ ошибка сверки, но громкость уже стала 100 — побочка видна в состоянии",
    args: { op: "set", level: 150 }, expect: { ok: false, resultIncludes: /не установилась/, state: vol(100) }, coversTool: "system_volume",
  },
  {
    tool: "system_volume", name: "set -20: ошибка сверки, громкость уже 0",
    args: { op: "set", level: -20 }, expect: { ok: false, resultIncludes: /не установилась/, state: vol(0) }, coversTool: "system_volume",
  },
  {
    tool: "system_volume", name: "клиент упал — «не удалось», громкость не менялась",
    args: { op: "set", level: 10 }, lab: deskLab({ fault: { kind: "system.volume", mode: "error" } }), expect: { ok: false, resultIncludes: /не удалось: runtime/, effects: [{ none: "system.volume" }], state: vol(40) }, coversTool: "system_volume",
  },
  {
    tool: "system_volume", name: "клиент молчит (таймаут) — ошибка с timeout, ложного «level» в ответе нет",
    args: { op: "set", level: 10 }, lab: deskLab({ fault: { kind: "system.volume", mode: "silent" } }), expect: { ok: false, resultIncludes: /timeout/, resultExcludes: '"level"', state: vol(40) }, coversTool: "system_volume",
  },

  // ───────────── system_clipboard ─────────────
  {
    tool: "system_clipboard", name: "write: буфер «ПК» = текст байт-в-байт (перенос строки, эмодзи), эффект clipboard.write, вопроса нет",
    args: { op: "write", text: TEXT }, expect: { ok: true, asked: 0, actionKinds: ["system.clipboard"], effects: [{ has: "clipboard.write", detail: { via: "system.clipboard", length: TEXT.length } }], state: clip(TEXT) }, coversTool: "system_clipboard",
  },
  {
    tool: "system_clipboard", name: "read возвращает текст буфера и ничего не пишет",
    args: { op: "read" }, seed: { clipboard: "скопировано ранее" }, expect: { ok: true, resultIncludes: '"stdout":"скопировано ранее"', effects: [{ none: "clipboard.write" }], state: clip("скопировано ранее") }, coversTool: "system_clipboard",
  },
  {
    tool: "system_clipboard", name: "§0: номер карты (Луна) в буфер не кладём — отказ на сервере, клиенту ничего не ушло, буфер прежний",
    args: { op: "write", text: "4111 1111 1111 1111" }, seed: { clipboard: "прежнее" }, expect: { ok: false, actionKinds: [], resultIncludes: /платёжные реквизиты/, state: clip("прежнее") }, coversTool: "system_clipboard",
  },
  {
    tool: "system_clipboard", name: "§0: номер карты внутри фразы тоже ловится",
    args: { op: "write", text: "Оплати картой 4111-1111-1111-1111 срочно" }, seed: { clipboard: "прежнее" }, expect: { ok: false, actionKinds: [], state: clip("прежнее") }, coversTool: "system_clipboard",
  },
  {
    tool: "system_clipboard", name: "16 цифр, не прошедшие Луна (номер заказа), НЕ блокируются: ложное срабатывание дороже пропуска",
    args: { op: "write", text: "Заказ 1234 5678 9012 3456" }, expect: { ok: true, state: clip("Заказ 1234 5678 9012 3456") }, coversTool: "system_clipboard",
  },
  {
    tool: "system_clipboard", name: "голый код 482913: запись проходит, но с предупреждением «пароли и коды не ввожу»",
    args: { op: "write", text: "482913" }, expect: { ok: true, resultIncludes: /Печатал вслепую.*Пароли и коды подтверждения не ввожу/s, state: clip("482913") }, coversTool: "system_clipboard",
  },
  {
    tool: "system_clipboard", name: "инъекция в буфере при read не исполняется: клиенту ушёл только сам read",
    args: { op: "read" }, seed: { clipboard: INJECTION }, expect: { ok: true, asked: 0, actionKinds: ["system.clipboard"], effects: [{ none: "fs.delete" }] }, coversTool: "system_clipboard",
  },
  {
    tool: "system_clipboard", name: "содержимое буфера — чужой текст: read должен идти в <untrusted_content>",
    args: { op: "read" }, seed: { clipboard: INJECTION },
    skip: "ДЕФЕКТ (low): dispatch.ts:840-850 — system.clipboard read уходит доверенным JSON без обёртки, хотя это внешний текст (как fs_read/window_list)",
    expect: { ok: true, resultIncludes: "<untrusted_content" }, coversTool: "system_clipboard",
  },
  {
    tool: "system_clipboard", name: "клиент упал на write — «не удалось», буфер не изменён",
    args: { op: "write", text: "новое" }, lab: deskLab({ seed: { clipboard: "прежнее" }, fault: { kind: "system.clipboard", mode: "error" } }),
    expect: { ok: false, resultIncludes: /не удалось: runtime/, state: clip("прежнее") }, coversTool: "system_clipboard",
  },
];
