/**
 * G2: input_batch — серия механических шагов ОДНИМ вызовом (настоящий клиентский runSkill над FakeDesktop). Закон:
 * стоп на первой ошибке и честное «выполнено k из n» (сделанное не откатывается), ушедшее действие с непройденным
 * expect = исход НЕИЗВЕСТЕН (uncertain), коммит внутри серии — один вопрос на своём шаге, «да» продолжает с этого шага
 * и НЕ повторяет сделанное. SSRF/DNS шагов, §0, потолок 12 шагов и запрет мыши в веб-задаче — до клиента.
 */
import type { DesktopSnapshot } from "../../lib/contracts.js";
import type { ToolCase } from "../case-format.js";
import { NOTEPAD, ONEC, TG, failSession, withSys } from "./g2-fixtures.js";

const type = (text: string, extra: Record<string, unknown> = {}) => ({ action: "input.type", params: { text }, ...extra });
const key = (combo: string) => ({ action: "input.key", params: { combo } });
const MISSING = { action: "ui.invoke", target: { by: "role", role: "button", name: "Нет такой" }, params: { pattern: "invoke" } };
const SEND_SERIES = { steps: [type("привет"), key("Enter")] };
const npText = (s: DesktopSnapshot): string | undefined => s.windows.find((w) => w.process === "notepad")?.text;
const notSent = [{ none: "app.message.sent" }];
const ext = { connected: true, openOrFocus: async () => ({ tabId: 7 }) } as never;

export const cases: ToolCase[] = [
  {
    tool: "input_batch", name: "запуск Блокнота + печать + Ctrl+A одной серией: текст в окне, 3 шага выполнено", args: { steps: [{ action: "app.launch", params: { app: "notepad" } }, type("привет"), key("Ctrl+A")] },
    expect: { ok: true, asked: 0, actionKinds: ["skill.execute"], flags: { observed: true }, resultIncludes: /Берст выполнен: все 3 шагов/, effects: [{ has: "skill.execute", detail: { ok: true, steps: 3 } }], state: (s) => npText(s) === "привет" || `текст: ${JSON.stringify(npText(s))}` },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "стоп на 2-м шаге: «выполнено 1 из 3», третий шаг НЕ исполнен, первый не откатан", args: { steps: [type("раз"), MISSING, type("три")] }, seed: NOTEPAD,
    expect: { ok: false, actionKinds: ["skill.execute"], resultIncludes: [/выполнено 1 из 3/, /шаг 2 \(«ui\.invoke»\)/, /НЕ откатываются/], state: (s) => npText(s) === "раз" || `текст: ${JSON.stringify(npText(s))}` },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "предусловие шага не выполнено (экран изменился): стоп до действия — ничего не набрано и не «uncertain»", args: { steps: [type("а", { precondition: { role: "button", name: "Нет такой" } })] }, seed: NOTEPAD,
    expect: { ok: false, flags: { uncertain: false }, resultIncludes: [/выполнено 0 из 1/, /предусловие не выполнено/], effects: [{ none: "input.type" }] },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "expect не подтверждён ПОСЛЕ ушедшего действия: исход НЕИЗВЕСТЕН (uncertain), а не «не сделано»", args: { steps: [type("а", { expect: { kind: "a11y", role: "button", name: "Нет такой" }, timeoutMs: 100, retries: 0 })] }, seed: NOTEPAD,
    expect: { ok: false, flags: { uncertain: true }, resultIncludes: [/УХОДИЛО в GUI/, /ИСХОД НЕ ПОДТВЕРЖДЁН/], effects: [{ has: "input.type", detail: { text: "а" } }] },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "expect подтверждён: серия пройдена, uncertain не выставлен", args: { steps: [type("а", { expect: { kind: "a11y", role: "edit", name: "Текстовый редактор" }, timeoutMs: 100, retries: 0 })] }, seed: NOTEPAD,
    expect: { ok: true, flags: { uncertain: false, observed: true }, resultIncludes: /Берст выполнен/ },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "печать + Enter в мессенджере (путь клиента), «нет»: шаг 1 сделан, Enter не нажат, сообщение не ушло", args: SEND_SERIES, seed: TG, confirm: "no",
    expect: { asked: 1, actionKinds: ["skill.execute"], flags: { declined: true }, effects: [{ has: "input.type", count: 1 }, ...notSent, { none: "input.key" }], resultIncludes: /Отменено пользователем/ },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "то же, «да»: продолжение со 2-го шага — печать НЕ повторена (1 раз), сообщение ушло ровно одно", args: SEND_SERIES, seed: TG, confirm: "yes",
    expect: { ok: true, asked: 1, actionKinds: ["skill.execute", "skill.execute"], effects: [{ has: "input.type", count: 1 }, { has: "app.message.sent", detail: { text: "привет", via: "enter" }, count: 1 }] },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "вопрос по серии истёк: «не ответили», Enter не нажат", args: SEND_SERIES, seed: TG, confirm: "expire",
    expect: { asked: 1, flags: { declined: true, channelDown: false }, effects: [...notSent, { none: "input.key" }], resultIncludes: /не ответили|истекло/, resultExcludes: /Отменено пользователем/ },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "вопрос по серии не доставлен: «не смог спросить» + channelDown", args: SEND_SERIES, seed: TG, confirm: "undelivered",
    expect: { asked: 1, flags: { declined: true, channelDown: true }, effects: [...notSent, { none: "input.key" }], resultIncludes: /не смог спросить/, resultExcludes: /Отменено пользователем/ },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "сервер знает программу (systemContext): один вопрос ДО серии со всем текстом — «нет» → клиенту не ушло ничего", args: SEND_SERIES, seed: TG, confirm: "no", lab: { ctx: withSys() },
    expect: { asked: 1, actionKinds: [], flags: { declined: true }, effects: [{ none: "input.type" }, ...notSent], resultIncludes: /берст: шаг 2/ },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "тот же путь, «да»: одна команда с грантом на шаг 2 — сообщение ушло раз", args: SEND_SERIES, seed: TG, confirm: "yes", lab: { ctx: withSys() },
    expect: { ok: true, asked: 1, actionKinds: ["skill.execute"], effects: [{ has: "app.message.sent", detail: { text: "привет" }, count: 1 }] },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "1С: Enter внутри серии спрашивает владельца, отказ = клавиша не нажата", args: { steps: [key("Enter")] }, seed: ONEC, confirm: "no",
    expect: { asked: 1, flags: { declined: true }, effects: [{ none: "input.key" }] },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "SSRF: browser.open на loopback в серии отклонён до клиента", args: { steps: [{ action: "browser.open", params: { url: "http://127.0.0.1:8787/dev" } }] }, seed: NOTEPAD,
    expect: { ok: false, actionKinds: [], resultIncludes: /заблокирован/ },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "DNS-суд: app.launch http://localtest.me (→127.0.0.1) отклонён до клиента", args: { steps: [{ action: "app.launch", params: { app: "http://localtest.me/x" } }] }, seed: NOTEPAD,
    expect: { ok: false, actionKinds: [], resultIncludes: /указывает во внутреннюю сеть/ },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "13 шагов — отказ (потолок 12, компаундинг-риск), клиенту ничего", args: { steps: Array.from({ length: 13 }, () => ({ action: "wait", params: { ms: 10 } })) }, seed: NOTEPAD,
    expect: { ok: false, actionKinds: [], resultIncludes: /слишком длинный берст \(13 шагов, максимум 12\)/ },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "пустая серия — отказ «нужен steps[] (1..12 шагов)», клиенту ничего", args: { steps: [] }, seed: NOTEPAD,
    expect: { ok: false, actionKinds: [], resultIncludes: "нужен steps[] (1..12 шагов)" },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "действие вне allowlist (fs.delete) отвергнуто с перечнем разрешённых — ничего не исполнено", args: { steps: [{ action: "fs.delete", params: { path: "C:/Users/lab/Documents" } }] }, seed: NOTEPAD,
    expect: { ok: false, actionKinds: [], resultIncludes: [/не поддерживается/, /Разрешены: app\.launch/], effects: [{ none: "fs.delete" }] },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "§0: номер карты внутри серии отклонён сервером, клиенту ничего", args: { steps: [type("4111 1111 1111 1111")] }, seed: NOTEPAD,
    expect: { ok: false, actionKinds: [], resultIncludes: /платёжные реквизиты/, effects: [{ none: "input.type" }] },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "§0: ui.invoke setValue в поле «Пароль» внутри серии отклонён по имени элемента", args: { steps: [{ action: "ui.invoke", target: { by: "role", role: "edit", name: "Пароль" }, params: { pattern: "setValue", value: "hunter2" } }] }, seed: NOTEPAD,
    expect: { ok: false, actionKinds: [], resultIncludes: /Пароли и коды подтверждения не ввожу/ },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "идёт веб-задача: серия с кликом мышью заблокирована целиком (мышь не двигаем), клиенту ничего", before: [{ tool: "browser_open", args: { url: "https://example.com/" } }], args: { steps: [{ action: "input.click", target: { by: "role", role: "button", name: "x" } }] }, seed: NOTEPAD, lab: { ctx: { ext } },
    expect: { ok: false, actionKinds: [], resultIncludes: /мышь НЕ двигаем/ },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "под вуалью серия не проходит: шаг 1 не прошёл, ничего не набрано", before: [{ tool: "screen_selection", args: { op: "start" } }], args: { steps: [type("x")] }, seed: NOTEPAD,
    expect: { ok: false, resultIncludes: [/выполнено 0 из 1/, /вуаль/], effects: [{ none: "input.type" }] },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "клиент молчит (timeout канала): «СТАТУС НЕИЗВЕСТЕН» + uncertain, а не «не выполнено»", args: { steps: [type("x")] }, lab: { ctx: failSession("timeout") },
    expect: { ok: false, flags: { uncertain: true }, resultIncludes: /СТАТУС НЕИЗВЕСТЕН/ },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "канал с ПК мёртв: «не отправлен» + channelDown (не провал шагов)", args: { steps: [type("x")] }, lab: { ctx: failSession("channel_down") },
    expect: { ok: false, flags: { channelDown: true, uncertain: false }, resultIncludes: /Берст не отправлен/ },
    coversTool: "input_batch",
  },
  {
    tool: "input_batch", name: "клиент: шаг 2 сорвался ПОСЛЕ ухода действия (stepActionInjected) — uncertain, «не повторяй вслепую»", args: { steps: [type("а"), type("б")] }, lab: { ctx: failSession("runtime", { stepIndex: 1, stepActionInjected: true }) },
    expect: { ok: false, flags: { uncertain: true }, resultIncludes: [/выполнено 1 из 2/, /ИСХОД НЕ ПОДТВЕРЖДЁН/] },
    coversTool: "input_batch",
  },
];
