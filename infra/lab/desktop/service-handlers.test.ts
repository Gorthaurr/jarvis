import { afterEach, describe, expect, it } from "vitest";
import { createFakeDesktop, supportedKinds } from "./index.js";
import { resetServiceOptions } from "./service-handlers.js";
import { errOf, rig } from "./service-rig.js";

afterEach(() => resetServiceOptions());

const SERVICE_KINDS = ["code.run", "job.status", "skill.execute", "office.excel", "office.word", "obs.request", "message.send", "telegram.send", "telegram.read", "order.place", "jbrowser.open", "jbrowser.read", "jbrowser.inspect", "jbrowser.act", "jbrowser.login", "jbrowser.import_cookies"];

describe("проводка в FakeDesktop", () => {
  it("все виды сервисной группы объявлены в supportedKinds и отвечают через desktop.handle", async () => {
    const kinds = supportedKinds();
    for (const k of SERVICE_KINDS) expect(kinds).toContain(k);
    const d = createFakeDesktop();
    const res = await d.handle({ kind: "message.send", channel: "telegram", to: "Катя", body: "привет" }, { commandId: "x1", timeoutMs: 1000 });
    expect(res).toMatchObject({ commandId: "x1", ok: true });
    expect(d.snapshot().effects.find((e) => e.kind === "message.send")?.detail).toMatchObject({ to: "Катя", body: "привет" });
  });

  it("reset() обнуляет состояние сервисной группы (заказы/задания/чаты), не только эффекты", async () => {
    const d = createFakeDesktop({ files: { ".lab/telegram.json": JSON.stringify({ chats: [{ title: "Катя", peerId: "5" }] }) } });
    await d.handle({ kind: "telegram.send", to: "Катя", text: "раз" }, { commandId: "a", timeoutMs: 1 });
    d.reset({ files: { ".lab/telegram.json": JSON.stringify({ chats: [{ title: "Катя", peerId: "5" }] }) } });
    const read = await d.handle({ kind: "telegram.read", to: "Катя" }, { commandId: "b", timeoutMs: 1 });
    expect((read.data as { messages: unknown[] }).messages).toEqual([]);
  });
});

describe("message.send", () => {
  it("«отправка» = запись в эффекты; наружу ничего; messageId уникален", async () => {
    const r = rig();
    const a = await r.call({ kind: "message.send", channel: "vk", to: "id123", body: "привет" });
    const b = await r.call({ kind: "message.send", channel: "vk", to: "id123", body: "ещё" });
    expect((a.data as { messageId: string }).messageId).not.toBe((b.data as { messageId: string }).messageId);
    expect(r.kinds("message.send").map((e) => e.body)).toEqual(["привет", "ещё"]);
  });

  it("канал без живой сессии — fail-closed, эффекта нет (как клиент без кредов)", async () => {
    const r = rig(undefined, { connectedChannels: ["vk"] });
    const res = await r.call({ kind: "message.send", channel: "telegram", to: "x", body: "y" });
    expect(res.ok).toBe(false);
    expect(errOf(res)).toContain("канал telegram не подключён");
    expect(r.kinds("message.send")).toHaveLength(0);
  });

  it("пустой текст — отказ без эффекта", async () => {
    const r = rig();
    expect((await r.call({ kind: "message.send", channel: "vk", to: "x", body: "  " })).ok).toBe(false);
    expect(r.core.effects).toHaveLength(0);
  });
});

describe("order.place", () => {
  const order = { kind: "order.place" as const, vendor: "pizza", items: [{ name: "margarita" }], total: 500 };

  it("по умолчанию — как настоящий клиент: «не реализован (M7)»; заказ НЕ оформлен, попытка видна", async () => {
    const r = rig();
    const res = await r.call(order);
    expect(res.ok).toBe(false);
    expect(errOf(res)).toContain("не реализован (M7)");
    expect(r.kinds("order.place")).toHaveLength(0);
    expect(r.kinds("order.attempt")).toEqual([{ vendor: "pizza", total: 500, items: 1, placed: false }]);
  });

  it("режим record: запись без денег и с orderId", async () => {
    const r = rig(undefined, { orderMode: "record" });
    const res = await r.call(order);
    expect(res).toMatchObject({ ok: true, data: { orderId: "lab-order-1" } });
    expect(r.kinds("order.place")[0]).toMatchObject({ vendor: "pizza", total: 500, money: 0 });
  });

  it("красная линия карты §0 работает в любом режиме, эффектов нет", async () => {
    const r = rig(undefined, { orderMode: "record" });
    const res = await r.call({ ...order, items: [{ number: "4111 1111 1111 1111" }] });
    expect(res.ok).toBe(false);
    expect(errOf(res)).toContain("красная линия карты");
    expect(r.core.effects).toHaveLength(0);
  });
});

const tgFile = (chats: unknown[], loggedIn = true): Record<string, string> => ({ ".lab/telegram.json": JSON.stringify({ loggedIn, chats }) });

describe("telegram.send / telegram.read", () => {
  it("читает переписку из seed и дописывает исходящее; в эффектах — что ушло и в какой чат", async () => {
    const r = rig({ files: tgFile([{ title: "Катя Иванова", peerId: "7", messages: [{ dir: "in", text: "ты где?" }] }]) });
    const send = await r.call({ kind: "telegram.send", to: "Катя", text: "иду" });
    expect(send).toMatchObject({ ok: true, data: { delivered: true, chatTitle: "Катя Иванова", peerId: "7" } });
    const read = await r.call({ kind: "telegram.read", to: "Катя", count: 5 });
    expect((read.data as { messages: unknown[] }).messages).toEqual([{ dir: "in", text: "ты где?" }, { dir: "out", text: "иду" }]);
    expect(r.kinds("telegram.send")).toEqual([{ to: "Катя", chatTitle: "Катя Иванова", peerId: "7", text: "иду", confirmed: true }]);
  });

  it("count режет хвост переписки", async () => {
    const msgs = Array.from({ length: 6 }, (_v, i) => ({ dir: "in", text: `m${i}` }));
    const r = rig({ files: tgFile([{ title: "Оля", messages: msgs }]) });
    const read = await r.call({ kind: "telegram.read", to: "Оля", count: 2 });
    expect((read.data as { messages: Array<{ text: string }> }).messages.map((m) => m.text)).toEqual(["m4", "m5"]);
  });

  it("нет такого контакта — [tg-resolve] со списком видимых чатов, ничего не отправлено", async () => {
    const r = rig({ files: tgFile([{ title: "Оля" }, { title: "Борис" }]) });
    const res = await r.call({ kind: "telegram.send", to: "Вова", text: "хай" });
    expect(res.ok).toBe(false);
    expect(errOf(res)).toContain("[tg-resolve] Не нашёл в Telegram контакт «Вова»");
    expect(errOf(res)).toContain("Оля | Борис");
    expect(r.kinds("telegram.send")).toHaveLength(0);
  });

  it("тёзки — «спроси владельца», сообщение НЕ отправлено; с peer из списка — уходит точно тому", async () => {
    const r = rig({ files: tgFile([{ title: "Катя", peerId: "11" }, { title: "Катя Работа", peerId: "12" }]) });
    const amb = await r.call({ kind: "telegram.send", to: "Катя", text: "привет" });
    expect(amb.ok).toBe(false);
    expect(errOf(amb)).toContain("ТЁЗКИ");
    expect(errOf(amb)).toContain("id=11");
    expect(r.kinds("telegram.send")).toHaveLength(0);
    const exact = await r.call({ kind: "telegram.send", to: "Катя", text: "привет", preferredTitle: "Катя Работа", hintPeerId: "12" });
    expect(exact).toMatchObject({ ok: true, data: { chatTitle: "Катя Работа", peerId: "12" } });
  });

  it("не залогинен — честный отказ и окно входа в эффектах, вход лаборатория не имитирует", async () => {
    const r = rig({ files: tgFile([{ title: "Оля" }], false) });
    const res = await r.call({ kind: "telegram.send", to: "Оля", text: "x" });
    expect(errOf(res)).toContain("Telegram не залогинен");
    expect(r.kinds("jbrowser.login_window")).toEqual([{ url: "https://web.telegram.org/k/" }]);
    expect(r.kinds("telegram.send")).toHaveLength(0);
  });

  it("исход «ушло, но не подтвердилось»: ошибка «могло и уйти», при этом сообщение реально в чате и в эффектах", async () => {
    const r = rig({ files: tgFile([{ title: "Оля" }]) }, { telegramUnconfirmed: true });
    const res = await r.call({ kind: "telegram.send", to: "Оля", text: "важное" });
    expect(res.ok).toBe(false);
    expect(errOf(res)).toContain("доставка НЕ подтверждена (могло и уйти)");
    expect(r.kinds("telegram.send")[0]).toMatchObject({ text: "важное", confirmed: false });
    const read = await r.call({ kind: "telegram.read", to: "Оля" });
    expect((read.data as { messages: unknown[] }).messages).toEqual([{ dir: "out", text: "важное" }]);
  });

  it("без Chrome браузера Джарвиса нет; пустые поля отвергаются", async () => {
    const r = rig({ installedApps: ["notepad"], files: tgFile([{ title: "Оля" }]) });
    expect(errOf(await r.call({ kind: "telegram.read", to: "Оля" }))).toContain("Chrome не найден");
    const r2 = rig({ files: tgFile([{ title: "Оля" }]) });
    expect(errOf(await r2.call({ kind: "telegram.send", to: "Оля", text: " " }))).toContain("нужны to и text");
  });

  it("«Избранное» открывается без резолва", async () => {
    const r = rig();
    const res = await r.call({ kind: "telegram.send", to: "Избранное", text: "заметка" });
    expect(res).toMatchObject({ ok: true, data: { chatTitle: "Saved Messages" } });
  });
});
