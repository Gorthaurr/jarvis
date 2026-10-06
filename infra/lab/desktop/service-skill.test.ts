import type { ActionCommand, ActionResult, SkillStep } from "@jarvis/protocol";
import { describe, expect, it } from "vitest";
import type { DesktopCore } from "./core.js";
import { errOf, rig } from "./service-rig.js";

/** Мини-«рабочий стол» вместо соседних обработчиков GUI: ровно столько, сколько нужно шагам навыка. */
function desk(core: DesktopCore, opts: { ground?: Set<string>; failKinds?: Record<string, ActionResult["error"]>; failInjected?: string[] } = {}) {
  return (cmd: ActionCommand, m: { commandId: string }): ActionResult => {
    const bad = opts.failKinds?.[cmd.kind];
    if (bad) return { commandId: m.commandId, ok: false, durationMs: 1, error: bad, ...(opts.failInjected?.includes(cmd.kind) ? { stepActionInjected: true } : {}) };
    const fg = core.foreground !== null ? core.windows.get(core.foreground) : undefined;
    if (cmd.kind === "app.launch") {
      const hwnd = core.nextHwnd();
      core.windows.set(hwnd, { hwnd, pid: core.nextPid(), process: cmd.app, title: cmd.app, text: "", rect: { x: 0, y: 0, w: 1, h: 1 }, monitor: 1, minimized: false });
      core.foreground = hwnd;
      return core.ok(m.commandId, { window: { hwnd, title: cmd.app } });
    }
    if (cmd.kind === "input.type" && fg) fg.text += cmd.text;
    if (cmd.kind === "ui.ground") return opts.ground?.has(`${cmd.query.role}|${cmd.query.name ?? ""}`) ? core.ok(m.commandId, { handle: "h1" }) : core.fail(m.commandId, "not_found", "элемента нет");
    if (cmd.kind === "screen.ocr") return core.ok(m.commandId, { text: fg?.text ?? "" });
    return core.ok(m.commandId);
  };
}

const skill = (steps: SkillStep[], extra: Record<string, unknown> = {}) => ({ kind: "skill.execute" as const, skillId: "s1", version: 1, steps, ...extra }) as never;
const step = (action: string, params?: Record<string, unknown>, more: Partial<SkillStep> = {}): SkillStep => ({ action, ...(params ? { params } : {}), ...more });
const grant = (signature: string, process: string, count = 1) => ({ approval: { grants: [{ signature, process, count }], expiresAt: Date.now() + 60_000 } });

describe("skill.execute: серия шагов", () => {
  it("шаги идут по порядку через dispatch, результат ok с наблюдением, эффект записан", async () => {
    const r = rig();
    r.setDispatch(desk(r.core));
    const res = await r.call(skill([step("app.launch", { app: "notepad" }), step("input.type", { text: "привет" })]));
    expect(res.ok).toBe(true);
    expect(r.sent.map((s) => s.cmd.kind)).toEqual(["app.launch", "input.type"]);
    expect(r.sent.map((s) => s.commandId)).toEqual(["c1#1", "c1#2"]);
    expect(res.data).toMatchObject({ observation: { via: "a11y", window: "notepad", text: "привет" } });
    expect(r.kinds("skill.execute")).toEqual([{ skillId: "s1", version: 1, steps: 2, ok: true }]);
  });

  it("стоп на первой ошибке: stepIndex, дальнейшие шаги не исполняются, причина — текст шага", async () => {
    const r = rig();
    r.setDispatch(desk(r.core, { failKinds: { "app.focus": { code: "not_found", message: "окно не найдено" } } }));
    const res = await r.call(skill([step("app.launch", { app: "notepad" }), step("app.focus", { app: "ghost" }, { retries: 0 }), step("input.type", { text: "не должно уйти" })]));
    expect(res.ok).toBe(false);
    expect(res.stepIndex).toBe(1);
    expect(errOf(res)).toContain("окно не найдено");
    expect(r.sent.map((s) => s.cmd.kind)).not.toContain("input.type");
  });

  it("обычный шаг ретраится (2 повтора по умолчанию), а шаг-коммит (Enter) — НИКОГДА: повтор ушедшего = дубль", async () => {
    const a = rig();
    a.setDispatch(desk(a.core, { failKinds: { "app.focus": { code: "runtime", message: "сбой" } } }));
    await a.call(skill([step("app.focus", { app: "x" })]));
    expect(a.sent.filter((s) => s.cmd.kind === "app.focus")).toHaveLength(3);
    const b = rig();
    b.setDispatch(desk(b.core, { failKinds: { "input.key": { code: "runtime", message: "сбой" } } }));
    await b.call(skill([step("input.key", { combo: "Enter" })]));
    expect(b.sent.filter((s) => s.cmd.kind === "input.key")).toHaveLength(1);
  });

  it("expect не наступил после ушедшего ввода → ok:false, stepActionInjected (исход неизвестен, не «не сделано»)", async () => {
    const r = rig();
    r.setDispatch(desk(r.core, { ground: new Set() }));
    const res = await r.call(skill([step("input.type", { text: "abc" }, { expect: { role: "Button", name: "Готово" }, timeoutMs: 300, retries: 0 })]));
    expect(res.ok).toBe(false);
    expect(res.stepIndex).toBe(0);
    expect(res.stepActionInjected).toBe(true);
    expect(errOf(res)).toContain("не подтвердил expect");
  });

  it("expect наступил → шаг засчитан; предусловие не выполнено → стоп ДО действия", async () => {
    const r = rig();
    r.setDispatch(desk(r.core, { ground: new Set(["Button|Готово"]) }));
    expect((await r.call(skill([step("input.type", { text: "a" }, { expect: { role: "Button", name: "Готово" } })]))).ok).toBe(true);
    const before = r.sent.length;
    const pre = await r.call(skill([step("input.type", { text: "b" }, { precondition: { role: "Edit", name: "Поле" } })]));
    expect(pre.ok).toBe(false);
    expect(errOf(pre)).toContain("предусловие не выполнено");
    expect(r.sent.slice(before).map((s) => s.cmd.kind)).toEqual(["ui.ground"]);
  });

  it("visual-expect сверяется по OCR экрана", async () => {
    const r = rig();
    r.setDispatch(desk(r.core));
    const ok = await r.call(skill([step("app.launch", { app: "game" }), step("input.type", { text: "Победа!" }, { expect: { kind: "visual", text: "победа" }, retries: 0 })]));
    expect(ok.ok).toBe(true);
    const bad = await r.call(skill([step("input.type", { text: "x" }, { expect: { kind: "visual", text: "нет такого" }, timeoutMs: 200, retries: 0 })]));
    expect(bad.ok).toBe(false);
  });

  it("wait двигает виртуальные часы; неизвестный шаг — честная ошибка (настоящий клиент его молча пропустил бы)", async () => {
    const r = rig();
    r.setDispatch(desk(r.core));
    const t0 = r.core.now();
    await r.call(skill([step("wait", { ms: 5000 })]));
    expect(r.core.now() - t0).toBeGreaterThanOrEqual(5000);
    const bad = await r.call(skill([step("click", { x: 1 }, { retries: 0 })]));
    expect(bad.ok).toBe(false);
    expect(errOf(bad)).toContain("неизвестное действие шага «click»");
  });

  it("запуск через URI-схему (skype:, tg:) отказан без диспетчеризации", async () => {
    const r = rig();
    r.setDispatch(desk(r.core));
    const res = await r.call(skill([step("app.launch", { app: "skype:?call" })]));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied");
    expect(r.sent).toHaveLength(0);
  });

  it("бюджет реплея: длинная серия останавливается честно до конца, с номером шага", async () => {
    const r = rig(undefined, { skillBudgetMs: 350 });
    r.setDispatch(desk(r.core));
    const res = await r.call(skill(Array.from({ length: 10 }, () => step("input.type", { text: "a" }))));
    expect(res.ok).toBe(false);
    expect(errOf(res)).toContain("не уложился в бюджет");
    expect(res.stepIndex).toBeGreaterThan(0);
    expect(res.stepIndex).toBeLessThan(10);
  });
});

describe("skill.execute: рубеж §14", () => {
  const telegram = { windows: [{ title: "Telegram", process: "Telegram" }] };

  it("Enter в мессенджере без гранта: denied + needsApproval, клавиша НЕ нажата, номер шага назван", async () => {
    const r = rig(telegram);
    r.setDispatch(desk(r.core));
    const res = await r.call(skill([step("input.type", { text: "привет" }), step("input.key", { combo: "Enter" })]));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied");
    expect(res.stepIndex).toBe(1);
    expect(res.data).toMatchObject({ needsApproval: { signature: "key:enter", process: "telegram", category: "messenger" } });
    expect(r.sent.map((s) => s.cmd.kind)).toEqual(["input.type"]);
  });

  it("с грантом на эту подпись и процесс — уходит; грант пересылается вложенной команде; одно «да» = одно действие", async () => {
    const r = rig(telegram);
    r.setDispatch(desk(r.core));
    const one = await r.call(skill([step("input.key", { combo: "Enter" })], grant("key:enter", "telegram")));
    expect(one.ok).toBe(true);
    expect(r.sent[0]?.cmd.approval?.grants[0]).toMatchObject({ signature: "key:enter", process: "telegram", count: 1 });
    const two = await r.call(skill([step("input.key", { combo: "Enter" }), step("input.key", { combo: "Enter" })], grant("key:enter", "telegram")));
    expect(two.ok).toBe(false);
    expect(two.stepIndex).toBe(1);
  });

  it("грант на другой процесс, на другую подпись или истёкший — не действует", async () => {
    for (const g of [grant("key:enter", "discord"), grant("click:отправить", "telegram"), { approval: { grants: [{ signature: "key:enter", process: "telegram", count: 1 }], expiresAt: Date.now() - 1 } }]) {
      const r = rig(telegram);
      r.setDispatch(desk(r.core));
      const res = await r.call(skill([step("input.key", { combo: "Enter" })], g));
      expect(res.error?.code).toBe("denied");
      expect(r.sent).toHaveLength(0);
    }
  });

  it("клик «Отправить» по роли и имени судится по подписи; безопасная навигация («Назад») — нет", async () => {
    const r = rig(telegram);
    r.setDispatch(desk(r.core));
    const send = await r.call(skill([step("input.click", {}, { target: { by: "role", role: "Button", name: "Отправить" } })]));
    expect(send.data).toMatchObject({ needsApproval: { signature: "click:отправить" } });
    const back = await r.call(skill([step("input.click", {}, { target: { by: "role", role: "Button", name: "Назад" } })]));
    expect(back.ok).toBe(true);
  });

  it("печать с переводом строки в мессенджере = Enter внутри текста → тоже вопрос (pendingText — что уйдёт)", async () => {
    const r = rig(telegram);
    r.setDispatch(desk(r.core));
    const res = await r.call(skill([step("input.type", { text: "строка1\nстрока2" })]));
    expect(res.data).toMatchObject({ needsApproval: { signature: "key:enter", pendingText: expect.stringContaining("строка1") } });
  });

  it("обычная программа (Блокнот) §14 не судит — Enter без гранта проходит", async () => {
    const r = rig({ windows: [{ title: "Notepad", process: "notepad" }] });
    r.setDispatch(desk(r.core));
    expect((await r.call(skill([step("input.key", { combo: "Enter" })]))).ok).toBe(true);
  });
});
