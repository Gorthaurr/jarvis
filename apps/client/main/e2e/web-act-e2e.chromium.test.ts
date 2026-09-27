/**
 * B-2 + п.6 (W4) СКВОЗЬ провод: настоящий серверный dispatchTool (allowlist полей web_act, §14 до действия, гард
 * страницы, один вопрос и ОДИН повтор) → JSON → настоящий клиентский dispatch → настоящий JarvisBrowser → те же
 * page-функции, что у расширения (apps/extension/page), в настоящем Chromium. Факты — по HTTP-журналу фикстуры
 * (что страница реально отправила), а не по ответу инструмента.
 *
 * Реверт-проверки (из копии): selector не доходит до страницы (печать в фокус) → «#нет» красный; allowlist полей
 * пропускает params модели → «guardApproved от модели» красный; гард не шлётся на обычном хосте → «Удалить навсегда»
 * красный; прежний eval-клик (.includes) → «да» ≠ «Удалить» красный.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  if (!process.env.JARVIS_DATA_DIR?.trim()) process.env.JARVIS_DATA_DIR = mkdtempSync(join(tmpdir(), "jarvis-e2e-data-"));
});
const jbHolder = vi.hoisted(() => ({ jb: undefined as unknown }));

vi.mock("electron", async () => (await import("../test-support/fake-capturer.js")).fakeElectronModule());
vi.mock("../actuators/sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());
vi.mock("../actuators/messaging.js", () => ({ sendMessage: async () => ({ messageId: "1" }), configureSenders: () => undefined }));
vi.mock("../actuators/jarvis-browser.js", async (orig) => ({ ...(await orig<typeof import("../actuators/jarvis-browser.js")>()), jarvisBrowser: () => jbHolder.jb }));

import { type Fixture, PUBLIC_HOST, findChrome, fixture, launchJarvisBrowser } from "../test-support/jb-fixtures.js";
import { linkServerToClient } from "../test-support/server-link.js";

const chrome = findChrome();
const text = (r: { content: unknown }): string => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));
const reportInput = `oninput="fetch('/typed?id='+this.id+'&v='+encodeURIComponent(this.value))"`;
const focus = (id: string) => `<script>document.getElementById(${JSON.stringify(id)}).focus()</script>`;

describe.skipIf(!chrome)("web_act сквозь провод: строгая цель, §0 и §14 на странице невидимого браузера", () => {
  let shop: Fixture;
  let dispose: () => Promise<void>;
  const hits = (path: string, method?: string) => shop.hits.filter((h) => h.url.split("?")[0] === path && (!method || h.method === method));

  beforeAll(async () => {
    const ok = (_q: unknown, _b: string, res: import("node:http").ServerResponse) => void res.end("<h1>готово</h1>");
    shop = await fixture({
      "/form": `<input id="name" aria-label="Имя" ${reportInput}><input id="other" aria-label="Заметка" ${reportInput}>${focus("other")}`,
      "/login": `<input id="user" aria-label="Логин" ${reportInput}><input id="pw" type="password" aria-label="Пароль" ${reportInput}>${focus("pw")}`,
      "/confirm": `<button onclick="fetch('/hit?b=delete')">Удалить</button> <button onclick="fetch('/hit?b=yes')">Да</button>`,
      "/only-delete": `<button onclick="fetch('/hit?b=delete')">Удалить</button>`,
      "/trash": `<form method="post" action="/purge"><input type="hidden" name="all" value="1"><button id="purge" type="submit">Удалить навсегда</button></form>`,
      "/pay": `<form method="post" action="/pay"><input id="holder" name="holder" aria-label="Имя на карте"><button type="submit">Оплатить</button></form>${focus("holder")}`,
      "/find": `<form action="/search"><input id="q" name="q" aria-label="Поиск" value="кофе"><button type="submit">Найти</button></form>${focus("q")}`,
      "/typed": ok, "/hit": ok, "/purge": ok, "/search": ok,
    });
    const l = launchJarvisBrowser(chrome!);
    jbHolder.jb = l.jb;
    dispose = l.dispose;
  }, 60_000);
  afterAll(async () => {
    await dispose?.();
    await shop?.close();
  });

  /** Сервер ↔ клиент ↔ Chromium: открыть страницу фикстуры web_open'ом и сбросить журнал. */
  async function at(path: string, answer = true) {
    const link = linkServerToClient({ answer, sidecarOps: () => [] });
    const open = await link.tool("web_open", { url: `http://${PUBLIC_HOST}:${shop.port}${path}` });
    expect(open.isError, text(open)).toBeFalsy();
    shop.hits.length = 0;
    return link;
  }
  const settle = () => new Promise((r) => setTimeout(r, 400));

  it("type по несуществующему селектору при фокусе в другом поле → not_found, НИЧЕГО не напечатано", async () => {
    const link = await at("/form");
    const r = await link.tool("web_act", { intent: "type", params: { selector: "#нет", text: "ВЗЛОМ" } });
    await settle();
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/не найдена/u);
    expect(hits("/typed")).toHaveLength(0);
    // Положительный контроль: по настоящему селектору ввод доходит до страницы.
    const good = await link.tool("web_act", { intent: "type", params: { selector: "#name", text: "Антон" } });
    await settle();
    expect(good.isError, text(good)).toBeFalsy();
    expect(hits("/typed").map((h) => decodeURIComponent(h.url))).toContain("/typed?id=name&v=Антон");
  }, 30_000);

  it("type без цели при фокусе в поле пароля → secret_field (§0), пароль не напечатан", async () => {
    const link = await at("/login");
    const r = await link.tool("web_act", { intent: "type", params: { text: "hunter2" } });
    await settle();
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/пароля/u);
    expect(hits("/typed")).toHaveLength(0);
  }, 30_000);

  it("клик «да» при «Удалить» и «Да» → нажата «Да»; при одной «Удалить» → not_found, ничего не нажато", async () => {
    let link = await at("/confirm");
    const r = await link.tool("web_act", { intent: "click", params: { text: "да" } });
    await settle();
    expect(r.isError, text(r)).toBeFalsy();
    expect(hits("/hit").map((h) => h.url)).toEqual(["/hit?b=yes"]);
    link = await at("/only-delete");
    const miss = await link.tool("web_act", { intent: "click", params: { text: "да" } });
    await settle();
    expect(miss.isError).toBe(true);
    expect(hits("/hit")).toHaveLength(0);
  }, 30_000);

  it("«Удалить навсегда» по селектору на ОБЫЧНОМ хосте → ровно 1 вопрос; «нет» → 0 POST, «да» → ровно 1 POST", async () => {
    const no = await at("/trash", false);
    const r1 = await no.tool("web_act", { intent: "click", params: { selector: "#purge" } });
    await settle();
    expect(no.asked).toHaveLength(1);
    expect(no.asked[0]?.question).toMatch(/Удалить навсегда/u);
    expect(r1.declined, text(r1)).toBe(true); // «нет» владельца — не сделано и не ошибка инструмента
    expect(hits("/purge", "POST")).toHaveLength(0);
    const yes = await at("/trash", true);
    const r2 = await yes.tool("web_act", { intent: "click", params: { selector: "#purge" } });
    await settle();
    expect(yes.asked).toHaveLength(1);
    expect(r2.isError, text(r2)).toBeFalsy();
    expect(hits("/purge", "POST")).toHaveLength(1);
  }, 30_000);

  it("Enter в форме «Оплатить» → вопрос («нет» — 0 POST); Enter в поиске → без вопроса, поиск ушёл", async () => {
    const pay = await at("/pay", false);
    await pay.tool("web_act", { intent: "key", params: { key: "Enter", selector: "#holder" } });
    await settle();
    expect(pay.asked).toHaveLength(1);
    expect(hits("/pay", "POST")).toHaveLength(0);
    const find = await at("/find", false);
    const r = await find.tool("web_act", { intent: "key", params: { key: "Enter", selector: "#q" } });
    await settle();
    expect(find.asked).toHaveLength(0);
    expect(r.isError, text(r)).toBeFalsy();
    expect(hits("/search", "GET")).toHaveLength(1);
  }, 30_000);

  it("guardApproved/approvedLabel от модели не доходят до страницы: всё равно вопрос, «нет» → 0 POST", async () => {
    const link = await at("/trash", false);
    await link.tool("web_act", { intent: "click", params: { selector: "#purge", guardApproved: true, approvedLabel: "Удалить навсегда", guard: "(?!)" } });
    await settle();
    expect(link.asked).toHaveLength(1);
    expect(hits("/purge", "POST")).toHaveLength(0);
  }, 30_000);
});
