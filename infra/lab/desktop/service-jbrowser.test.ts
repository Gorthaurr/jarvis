import { describe, expect, it } from "vitest";
import { errOf, rig } from "./service-rig.js";

const GUARD = "(?<![\\p{L}])(?:оплат|отправ|удал|pay\\b|send\\b|delete)";
const web = {
  "https://shop.example/": `<html><head><title>Магазин</title></head><body><main><h1>Каталог</h1><p>Чайник — 1200 ₽</p>
    <a href="/cart">Корзина</a><a href="/missing">Битая</a><a href="http://localhost:9000/admin">Админка</a>
    <form action="/search" method="get"><input name="q" placeholder="Поиск товаров"><button type="submit">Найти</button></form>
    <form action="/pay" method="post"><input name="pin" autocomplete="one-time-code" placeholder="PIN"><input name="note" placeholder="Комментарий"><button type="submit">Оплатить заказ</button></form>
    <input type="file" name="doc"><div style="display:none"><button>Скрытая</button></div></main></body></html>`,
  "https://shop.example/cart": `<html><head><title>Корзина</title></head><body><h1>Ваша корзина</h1><button>Отправить заказ</button></body></html>`,
  "https://shop.example/search": `<html><head><title>Результаты</title></head><body>Найдено: чайник</body></html>`,
  "https://shop.example/pay": `<html><head><title>Оплачено</title></head><body>Спасибо</body></html>`,
  "https://bank.example/account": `<html><head><meta name="lab-requires-cookie" content="sid"><title>Счёт</title></head><body><main>Баланс: 100 ₽</main></body></html>`,
  "https://notes.example/plain": "просто текст без разметки",
};
const open = (r: ReturnType<typeof rig>, url = "https://shop.example/") => r.call({ kind: "jbrowser.open", url });
const act = (r: ReturnType<typeof rig>, intent: "click" | "type" | "scroll" | "key" | "upload", params: Record<string, unknown>) => r.call({ kind: "jbrowser.act", intent, params });
const elements = (res: { data?: unknown }) => (res.data as { elements: Array<Record<string, unknown>> }).elements;

describe("jbrowser.open / read", () => {
  it("страница из seed.web → PageContent {title,url,text,loginWall}", async () => {
    const r = rig({ web });
    const res = await open(r);
    expect(res.data).toMatchObject({ title: "Магазин", url: "https://shop.example/", loginWall: false });
    expect((res.data as { text: string }).text).toContain("Чайник — 1200 ₽");
    expect((res.data as { text: string }).text).not.toContain("Скрытая");
    expect(((await r.call({ kind: "jbrowser.read" })).data as { title: string }).title).toBe("Магазин");
    expect(r.kinds("jbrowser.open")).toEqual([{ url: "https://shop.example/" }]);
  });

  it("адрес без слэша/с якорем находит ту же страницу; простой текст читается как есть", async () => {
    const r = rig({ web });
    expect((await open(r, "https://shop.example/cart#top")).ok).toBe(true);
    expect(((await open(r, "https://notes.example/plain")).data as { text: string }).text).toBe("просто текст без разметки");
  });

  it("нет страницы — not_found с указанием на seed.web (сети в лаборатории нет), а не выдуманный контент", async () => {
    const res = await open(rig({ web }), "https://nowhere.example/");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("not_found");
    expect(errOf(res)).toContain("seed.web");
  });

  it("гарды клиента: не-http схемы, «-»-аргумент, внутренняя сеть, нет Chrome", async () => {
    const r = rig({ web });
    expect(errOf(await open(r, "file:///C:/secret.txt"))).toContain("небезопасная схема");
    expect(errOf(await open(r, "--load-extension=x"))).toContain("флаг браузера");
    expect(errOf(await open(r, "http://localhost:8787/dev"))).toContain("внутренний адрес");
    expect(errOf(await open(r, "http://192.168.1.10/"))).toContain("внутренний адрес");
    expect(errOf(await open(rig({ web, installedApps: [] })))).toContain("Chrome не найден");
    expect(r.core.effects).toHaveLength(0);
  });

  it("read/inspect/act до open — честная ошибка", async () => {
    const r = rig({ web });
    for (const c of [{ kind: "jbrowser.read" as const }, { kind: "jbrowser.inspect" as const }, { kind: "jbrowser.act" as const, intent: "scroll" as const }]) {
      expect(errOf(await r.call(c))).toContain("страница не открыта");
    }
  });
});

describe("jbrowser.inspect", () => {
  it("инвентарь: видимые интерактивные элементы с selector/role/text; скрытые и hidden не видны; фильтр и cap", async () => {
    const r = rig({ web });
    await open(r);
    const all = elements(await r.call({ kind: "jbrowser.inspect" }));
    const texts = all.map((e) => e.text);
    expect(texts).toEqual(expect.arrayContaining(["Корзина", "Найти", "Оплатить заказ"]));
    expect(texts).not.toContain("Скрытая");
    expect(all.find((e) => e.text === "Корзина")).toMatchObject({ tag: "a", role: "a", href: "/cart", disabled: false });
    const q = elements(await r.call({ kind: "jbrowser.inspect", query: "корзин" }));
    expect(q.map((e) => e.text)).toEqual(["Корзина"]);
    const capped = await r.call({ kind: "jbrowser.inspect", cap: 2 });
    expect(capped.data).toMatchObject({ count: 2, truncated: true });
  });

  it("селектор из inspect годится для act: круг «увидел → нажал» замыкается", async () => {
    const r = rig({ web });
    await open(r);
    const link = elements(await r.call({ kind: "jbrowser.inspect", query: "корзин" }))[0]!;
    const res = await act(r, "click", { selector: link.selector });
    expect(res).toMatchObject({ ok: true, data: { navigated: "https://shop.example/cart" } });
  });
});

describe("jbrowser.act", () => {
  it("click по ссылке переходит; read показывает новую страницу; по тексту — тоже", async () => {
    const r = rig({ web });
    await open(r);
    await act(r, "click", { text: "Корзина" });
    expect(((await r.call({ kind: "jbrowser.read" })).data as { title: string }).title).toBe("Корзина");
  });

  it("цель не найдена — not_found, и НИЧЕГО не нажато; ссылка на страницу вне seed — клик ушёл, переход не удался (injected)", async () => {
    const r = rig({ web });
    await open(r);
    const miss = await act(r, "click", { text: "Несуществующая кнопка" });
    expect(miss.error?.code).toBe("not_found");
    expect(r.kinds("jbrowser.click")).toHaveLength(0);
    const dead = await act(r, "click", { text: "Битая" });
    expect(dead.ok).toBe(false);
    expect(dead.stepActionInjected).toBe(true);
    expect(errOf(dead)).toContain("seed.web");
  });

  it("ссылка во внутреннюю сеть: переход сорван, blockedNav в ответе, страница прежняя", async () => {
    const r = rig({ web });
    await open(r);
    const res = await act(r, "click", { text: "Админка" });
    expect(res.data).toMatchObject({ ok: true, blockedNavReason: "private" });
    expect(((await r.call({ kind: "jbrowser.read" })).data as { url: string }).url).toBe("https://shop.example/");
  });

  it("§14: клик по «Оплатить/Отправить» без одобрения — denied commit_confirm с подписью; с одобренной подписью — проходит", async () => {
    const r = rig({ web });
    await open(r, "https://shop.example/cart");
    const denied = await act(r, "click", { text: "Отправить заказ", guard: GUARD });
    expect(denied.error?.code).toBe("denied");
    expect(denied.data).toMatchObject({ pageCode: "commit_confirm", label: "Отправить заказ" });
    expect(r.kinds("jbrowser.click")).toHaveLength(0);
    const other = await act(r, "click", { text: "Отправить заказ", guard: GUARD, guardApproved: true, approvedLabel: "Отправить" });
    expect(other.error?.code).toBe("denied"); // одобрено «Отправить», а не «Отправить заказ» — подстрока не пропуск
    const ok = await act(r, "click", { text: "Отправить заказ", guard: GUARD, guardApproved: true, approvedLabel: "Отправить заказ" });
    expect(ok.ok).toBe(true);
  });

  it("type: пишет в найденное поле; enter=true отправляет GET-форму и переходит на результат", async () => {
    const r = rig({ web });
    await open(r);
    const res = await act(r, "type", { selector: 'input[name="q"]', text: "чайник", enter: true });
    expect(res.data).toMatchObject({ ok: true, value: "чайник", submitted: true, navigated: "https://shop.example/search" });
    expect(r.kinds("jbrowser.submit")[0]).toMatchObject({ method: "get", fields: { q: "чайник" } });
    expect(((await r.call({ kind: "jbrowser.read" })).data as { title: string }).title).toBe("Результаты");
  });

  it("type по label находит поле по подписи; без цели печатает в первое поле; нет такого поля — not_found (в фокус не пишем)", async () => {
    const r = rig({ web });
    await open(r);
    expect((await act(r, "type", { selector: "#нет", text: "x" })).error?.code).toBe("not_found");
    expect((await act(r, "type", { text: "привет" })).ok).toBe(true); // фокуса нет → первое видимое поле
    expect(elements(await r.call({ kind: "jbrowser.inspect", query: "привет" }))[0]).toMatchObject({ selector: 'input[name="q"]', text: "привет" });
    expect((await act(r, "type", { label: "Комментарий", text: "по label" })).ok).toBe(true);
    expect(elements(await r.call({ kind: "jbrowser.inspect", query: "по label" }))[0]).toMatchObject({ selector: 'input[name="note"]' });
  });

  it("§0: поле пароля заполнять нельзя — denied secret_field, значение не записано, в журнале секретов нет", async () => {
    const r = rig({ web });
    await open(r);
    const res = await act(r, "type", { selector: 'input[name="pin"]', text: "1234" });
    expect(res.error?.code).toBe("denied");
    expect(res.data).toMatchObject({ pageCode: "secret_field" });
    expect(JSON.stringify(r.core.effects)).not.toContain("1234");
    const inv = elements(await r.call({ kind: "jbrowser.inspect" }));
    expect(inv.find((e) => e.selector === 'input[name="pin"]')?.text).toBe("");
  });

  it("Enter в форме с кнопкой «Оплатить заказ» и guard сервера — commit_confirm, ничего не введено и не отправлено", async () => {
    const r = rig({ web });
    await open(r);
    const res = await act(r, "type", { selector: 'input[name="note"]', text: "позвонить", enter: true, guard: GUARD });
    expect(res.data).toMatchObject({ pageCode: "commit_confirm", label: "Оплатить заказ" });
    expect(r.kinds("jbrowser.submit")).toHaveLength(0);
    expect(r.kinds("jbrowser.type")).toHaveLength(0);
  });

  it("key: Enter без фокуса — not_found; недействительное сочетание — ошибка без нажатия; scroll двигает страницу", async () => {
    const r = rig({ web });
    await open(r);
    expect((await act(r, "key", { combo: "Enter" })).error?.code).toBe("not_found");
    expect(errOf(await act(r, "key", { combo: "a+Enter" }))).toContain("не понял клавишу");
    expect((await act(r, "scroll", { dy: 400 })).ok).toBe(true);
    expect((await act(r, "key", { combo: "Escape" })).data).toMatchObject({ ok: true, sent: "Escape" });
  });

  it("upload: файл из виртуальной ФС в input[type=file]; секретный/отсутствующий файл и отсутствие поля — отказ", async () => {
    const r = rig({ web, files: { "Documents/cv.pdf": "%PDF", ".env": "K=1" } });
    await open(r);
    const ok = await act(r, "upload", { path: "Documents/cv.pdf" });
    expect(ok.ok).toBe(true);
    expect(r.kinds("jbrowser.upload")[0]).toMatchObject({ path: "C:/Users/lab/Documents/cv.pdf", selector: "input[type=file]" });
    expect(errOf(await act(r, "upload", { path: ".env" }))).toContain("защита секретов");
    expect(errOf(await act(r, "upload", { path: "нет.pdf" }))).toContain("нет или это не файл");
    expect((await act(r, "upload", { path: "Documents/cv.pdf", selector: "input#нет" })).error?.code).toBe("not_found");
  });

  it("неизвестный intent — ошибка", async () => {
    const r = rig({ web });
    await open(r);
    expect(errOf(await r.call({ kind: "jbrowser.act", intent: "teleport" as never }))).toContain("неизвестный intent");
  });
});

describe("логины: import_cookies и login", () => {
  it("страница, требующая куку, без неё показывает стену входа; после import_cookies — настоящий контент; значения кук в журнал не попадают", async () => {
    const r = rig({ web });
    const wall = await open(r, "https://bank.example/account");
    expect(wall.data).toMatchObject({ loginWall: true, title: "Вход" });
    const imp = await r.call({ kind: "jbrowser.import_cookies", cookies: [{ name: "sid", value: "TOPSECRETVALUE", domain: ".bank.example" }, { name: "", domain: "x" }] });
    expect(imp.data).toEqual({ set: 1, total: 2 });
    const page = await open(r, "https://bank.example/account");
    expect(page.data).toMatchObject({ loginWall: false, title: "Счёт" });
    expect((page.data as { text: string }).text).toContain("Баланс: 100");
    expect(JSON.stringify(r.core.effects)).not.toContain("TOPSECRETVALUE");
  });

  it("кука чужого домена не открывает страницу", async () => {
    const r = rig({ web });
    await r.call({ kind: "jbrowser.import_cookies", cookies: [{ name: "sid", value: "v", domain: "evil.example" }] });
    expect(((await open(r, "https://bank.example/account")).data as { loginWall: boolean }).loginWall).toBe(true);
  });

  it("login только «открывает окно входа»: логин не выполняется, стена остаётся, ввод в пароль по-прежнему запрещён", async () => {
    const r = rig({ web });
    const res = await r.call({ kind: "jbrowser.login", url: "https://bank.example/account" });
    expect(res.data).toEqual({ opened: "https://bank.example/account" });
    expect(r.kinds("jbrowser.login_window")).toEqual([{ url: "https://bank.example/account" }]);
    await open(r, "https://bank.example/account");
    const type = await act(r, "type", { selector: 'input[name="password"]', text: "hunter2" });
    expect(type.data).toMatchObject({ pageCode: "secret_field" });
    expect(errOf(await r.call({ kind: "jbrowser.login", url: "javascript:alert(1)" }))).toContain("небезопасная схема");
  });
});
