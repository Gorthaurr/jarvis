/**
 * W4 «Руки» / W2 (пакет 0, разрез act.test.ts): ПОИСК цели act — лестница handle → точка → снапшот UIA → OCR.
 * Идёт через реальный act() (act-find/act-do/act-verify), мокаются только листья (test-support/act-mocks). Владелец — П5.
 *
 * Что охраняется (каждый кейс реверт-проверяем):
 *  - неоднозначная цель → ошибка со списком, НИЧЕГО не нажато («выбрать первый» = клик не туда с ok);
 *  - точное имя > префикс > подстрока; роль сужает; не найдено → что реально видно;
 *  - OCR без маппинга → честная ошибка; под точкой контейнер → физический клик в точку (H-A1); своё окно (H-A2);
 *  - бюджет: ступень, на которую времени нет, не начинается.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const st = await vi.hoisted(async () => (await import("../test-support/act-mocks.js")).createActState());
vi.mock("./ground.js", async () => (await import("../test-support/act-mocks.js")).actMocks.ground(st));
vi.mock("./screen.js", async () => (await import("../test-support/act-mocks.js")).actMocks.screen());
vi.mock("./sensors-cheap.js", async () => (await import("../test-support/act-mocks.js")).actMocks.sensors(st));
vi.mock("./input.js", async () => (await import("../test-support/act-mocks.js")).actMocks.input(st));
vi.mock("./paste-text.js", async () => (await import("../test-support/act-mocks.js")).actMocks.paste(st));
vi.mock("./observe.js", async () => (await import("../test-support/act-mocks.js")).actMocks.observe(st));
vi.mock("./windows.js", async () => (await import("../test-support/act-mocks.js")).actMocks.windows(st));
vi.mock("./apps.js", async () => (await import("../test-support/act-mocks.js")).actMocks.apps(st));

import { btn, resetActState } from "../test-support/act-mocks.js";
import { act } from "./act.js";
import { ActFindError, findTarget, scoreItem } from "./act-find.js";

const OPTS = { restoreCursor: true };
beforeEach(() => resetActState(st));

describe("act — поиск по снапшоту UIA", () => {
  it("точное имя побеждает подстроку: «Отправить» → invoke по handle 11, verify met → verified:met", async () => {
    const r = await act({ kind: "gui.act", target: "Отправить", verify: { text: "Отправлено" } }, OPTS);
    expect(st.invoke).toHaveBeenCalledTimes(1);
    expect(st.invoke.mock.calls[0]?.[0]).toEqual({ by: "handle", handle: "11" });
    expect(r.found).toMatchObject({ via: "snapshot", name: "Отправить", role: "Button", handle: "11" });
    expect(r.verified).toBe("met");
    expect(st.click).not.toHaveBeenCalled();
    expect(st.waitCalls).toContainEqual(expect.objectContaining({ cond: expect.objectContaining({ kind: "text", text: "Отправлено", gone: false }), timeoutMs: 4000 }));
  });

  it("две РАВНЫЕ кнопки «Отправить» → ошибка с кандидатами, ничего не нажато", async () => {
    st.items = [btn(11, "Отправить"), btn(21, "Отправить")];
    const p = act({ kind: "gui.act", target: "Отправить" }, OPTS);
    await expect(p).rejects.toBeInstanceOf(ActFindError);
    await expect(p).rejects.toThrow(/неоднозначна.*Button «Отправить»/su);
    expect(st.invoke).not.toHaveBeenCalled();
    expect(st.click).not.toHaveBeenCalled();
  });

  it("роль сужает поиск: target {text:'Поиск', role:'Edit'} → handle 13; чужая роль не матчится", async () => {
    const r = await act({ kind: "gui.act", target: { text: "Поиск", role: "Edit" }, do: "set", text: "кот" }, OPTS);
    expect(st.invoke).toHaveBeenCalledWith({ by: "handle", handle: "13" }, "setValue", "кот");
    expect(r.did).toMatch(/установил значение/u);
    await expect(act({ kind: "gui.act", target: { text: "Поиск", role: "Button" } }, OPTS)).rejects.toThrow(/не найдена/u);
  });

  it("не найдено → ошибка перечисляет ВИДИМЫЕ элементы и пометку об усечённом снапшоте", async () => {
    st.truncated = true;
    const p = act({ kind: "gui.act", target: "Скачать" }, OPTS);
    await expect(p).rejects.toThrow(/не найдена.*усечён.*Button «Отправить»/su);
    expect(st.ocrCalls).toBe(1); // OCR пробовали, тоже пусто
    expect(st.invoke).not.toHaveBeenCalled();
  });

  it("W2: найденный элемент несёт bbox (физика снапшота) и запрос модели отдельно от реального имени", async () => {
    st.items = [btn(11, "Отправить сообщение", "Button", { x: 5, y: 6, w: 70, h: 20 })];
    const found = await findTarget("Отправить", Date.now() + 30_000);
    expect(found).toMatchObject({ name: "Отправить сообщение", query: "Отправить", bbox: { x: 5, y: 6, w: 70, h: 20 } });
  });
});

describe("act — ступень OCR и точка", () => {
  it("в снапшоте нет → OCR-строка → центр в экранных DIP (mapping) → ground.at → бесшумный invoke", async () => {
    st.items = [];
    st.ocr = { text: "Играть", lines: [{ text: "Играть", x: 100, y: 50, w: 40, h: 20 }], mapping: { boundsX: 0, boundsY: 0, scale: 0.5 } };
    let at: { x: number; y: number } | null = null;
    st.groundAt = async (x, y) => {
      at = { x, y };
      return { handle: "77", bbox: { x: 0, y: 0, w: 80, h: 30 } };
    };
    const r = await act({ kind: "gui.act", target: "Играть" }, OPTS);
    expect(at).toEqual({ x: 240, y: 120 });
    expect(st.invoke).toHaveBeenCalledWith({ by: "handle", handle: "77" }, "invoke", undefined);
    expect(r.found).toMatchObject({ via: "ocr", handle: "77" });
    expect(r.verified).toBe("unchecked"); // verify не задан
  });

  it("OCR нашёл, под точкой UIA пусто → физический клик по координатам space:screen", async () => {
    st.items = [];
    st.ocr = { text: "Играть", lines: [{ text: "Играть", x: 100, y: 50, w: 40, h: 20 }], mapping: { boundsX: 0, boundsY: 0, scale: 0.5 } };
    st.groundAt = async () => {
      throw new Error("нет элемента");
    };
    st.click.mockResolvedValue({ screenX: 240, screenY: 120 });
    const r = await act({ kind: "gui.act", target: "Играть" }, OPTS);
    expect(st.invoke).not.toHaveBeenCalled();
    expect(st.click).toHaveBeenCalledWith({ by: "coords", x: 240, y: 120, space: "screen" }, "physical", true, {});
    expect(r).toMatchObject({ screenX: 240, screenY: 120, physical: true });
    expect(r.found?.note).toMatch(/физическим кликом/u);
  });

  it("OCR без маппинга (нет кадра) → честная ошибка, а не клик мимо", async () => {
    st.items = [];
    st.ocr = { text: "Играть", lines: [{ text: "Играть", x: 1, y: 1, w: 1, h: 1 }], mapping: undefined };
    await expect(act({ kind: "gui.act", target: "Играть" }, OPTS)).rejects.toThrow(/без маппинга/u);
    expect(st.click).not.toHaveBeenCalled();
  });

  it("цель-точка x/y: элемент под точкой → invoke по его handle; снапшот не читается", async () => {
    await act({ kind: "gui.act", target: { x: 10, y: 20 } }, OPTS);
    expect(st.snapshotCalls).toBe(0);
    expect(st.invoke).toHaveBeenCalledWith({ by: "handle", handle: "77" }, "invoke", undefined);
  });

  it("W2: точка в неизвестном кадре → честная ошибка до поиска и действия", async () => {
    await expect(act({ kind: "gui.act", target: { x: 10, y: 20, frame: "k1f9" } }, OPTS)).rejects.toThrow(/кадр «k1f9» неизвестен/u);
    expect(st.invoke).not.toHaveBeenCalled();
    expect(st.click).not.toHaveBeenCalled();
  });

  it("H-A1: под точкой крупный контейнер → физический клик В ТОЧКУ, не invoke по handle и не центр контейнера", async () => {
    st.groundAt = async () => ({ handle: "99", bbox: { x: 0, y: 0, w: 1343, h: 756 } });
    st.click.mockResolvedValue({ screenX: 500, screenY: 400 });
    const r = await act({ kind: "gui.act", target: { x: 500, y: 400, space: "screen" } }, OPTS);
    expect(st.invoke).not.toHaveBeenCalled();
    expect(st.click.mock.calls[0]?.[0]).toEqual({ by: "coords", x: 500, y: 400, space: "screen" });
    expect(r.found?.note ?? "").toMatch(/контейнер/);
  });

  it("H-A2: на переднем плане окно самого Джарвиса (pid = наш) → честный отказ, ничего не нажато", async () => {
    st.snapshotPid = process.pid;
    await expect(act({ kind: "gui.act", target: "Отправить" }, OPTS)).rejects.toThrow(/окно самого Джарвиса/);
    expect(st.invoke).not.toHaveBeenCalled();
    expect(st.click).not.toHaveBeenCalled();
  });

  it("бюджет: дедлайн истёк → снапшот не начинается; после снапшота на OCR времени нет → ошибка без OCR", async () => {
    await expect(findTarget("Скачать", Date.now() - 1)).rejects.toThrow(/Бюджет act исчерпан/u);
    expect(st.snapshotCalls).toBe(0);
    await expect(findTarget("Скачать", Date.now() + 5_000)).rejects.toThrow(/на OCR времени не осталось/u);
    expect(st.snapshotCalls).toBe(1);
    expect(st.ocrCalls).toBe(0);
  });
});

describe("scoreItem — чистая функция", () => {
  it("automationId точный > точное имя > префикс > подстрока > value; роль-фильтр", () => {
    const it0 = btn(1, "Отправить всем", "Button", { automationId: "SendAll", value: "" });
    expect(scoreItem(it0, { automationId: "sendall" })).toBe(40);
    expect(scoreItem(it0, { automationId: "other" })).toBe(0);
    expect(scoreItem(btn(1, "Отправить"), { text: "отправить" })).toBe(30);
    expect(scoreItem(it0, { text: "Отправить" })).toBe(20);
    expect(scoreItem(btn(1, "Не отправить"), { text: "отправить" })).toBe(10);
    expect(scoreItem(btn(1, "", "Edit", { value: "отправить письмо" }), { text: "отправить" })).toBe(5);
    expect(scoreItem(btn(1, "Отправить"), { text: "Отправить", role: "Edit" })).toBe(0);
    expect(scoreItem(btn(1, "Любая"), { role: "Button" })).toBe(1);
  });
});
