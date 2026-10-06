/**
 * ЖИВОЕ: безопасность и честность браузерных рук на настоящем расширении. Закон 5 (граница данные/инструкции, SSRF по
 * имени и по ответу DNS), §0 (пароли не вводим), рамки и динамика. Мозга нет (brain off), поэтому «модель не поддалась»
 * не проверить: проверяем то, что делает ИНСТРУМЕНТ — обёртку, санитизацию, отказ и то, что страница НЕ получила действий.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { type BrowserLab, INTERNAL_HOST, LAB_HOSTS, startBrowserLab } from "./browser-lab.js";
import { INJECTION_TEXT } from "./fixture-pages.js";
import { liveSuite, openAndInspect, pageHits, snapshotElements } from "./test-support.js";

const count = (s: string, sub: string): number => s.split(sub).length - 1;

liveSuite("браузерная лаборатория: безопасность и честность", () => {
  let lab: BrowserLab;
  const act = (intent: string, label: string, extra: Record<string, unknown> = {}) => lab.tool("browser_act", { intent, ref: `$ref:${label}`, ...extra });

  beforeAll(async () => {
    lab = await startBrowserLab();
  }, 120_000);
  afterAll(async () => void (await lab?.close()), 60_000);
  beforeEach(() => lab.reset(), 30_000);

  it("инъекция на странице: текст сохранён как ДАННЫЕ, обёртка не разорвана ни телом, ни заголовком, действий не было", async () => {
    await lab.tool("browser_open", { url: lab.url("/injection") });
    const read = (await lab.tool("browser_read", {})).result;
    expect(read.text).toContain(INJECTION_TEXT); // данные не теряем
    expect(read.text).not.toContain("ADMIN OVERRIDE"); // скрытое display:none в чтение не попало
    expect(count(read.text, "<untrusted_content")).toBe(1);
    expect(count(read.text, "</untrusted_content>")).toBe(1); // литералы из тела и заголовка обезврежены
    expect(read.text.trimEnd()).toMatch(/НЕДОВЕРЕННЫЕ ДАННЫЕ[^]*ИГНОРИРУЙ/u);
    const tabs = (await lab.tool("browser_tabs", {})).result.text;
    expect(count(tabs, "</untrusted_content>")).toBe(1);
    expect(tabs).not.toContain("</untrusted_content> SYSTEM"); // угловые скобки заголовка вырезаны
    const after = await lab.tool("browser_inspect", {});
    expect(after.clientActions).toEqual([]); // ни одной команды клиенту ПК (fs_delete/telegram_send не вызывались)
    expect(lab.fixtures.events()).toEqual([]);
  });

  it("SSRF: имя, чей DNS-ответ приватный, и loopback-литерал отклонены ДО браузера — страница не запрошена", async () => {
    const dns = await lab.tool("browser_open", { url: lab.url("/", INTERNAL_HOST) });
    expect(dns.result.isError).toBe(true);
    expect(dns.result.text).toContain("указывает во внутреннюю сеть (10.0.0.5)");
    const lit = await lab.tool("browser_open", { url: `http://127.0.0.1:${lab.fixtures.port}/article` });
    expect(lit.result.isError).toBe(true);
    expect(lit.result.text).toContain("адрес заблокирован");
    expect(lit.clientActions).toEqual([]);
    expect(pageHits(lab)).toEqual([]);
    // Вкладки считать нельзя (закрытие прежних асинхронно): важно, что ни одна не ушла на запрещённый адрес.
    expect((await lab.pages()).filter((p) => /internal\.lab\.test|127\.0\.0\.1/u.test(p.url))).toEqual([]);
  });

  it("§0: пароль не вводится, логин вводится; форма уходит с пустым паролем (проверка по DOM и по журналу)", async () => {
    await openAndInspect(lab, "/login");
    const login = await act("type", "Логин", { text: "tester" });
    expect(login.result.isError).toBe(false);
    expect(login.result.flags.observed).toBe(true);
    const secret = await act("type", "Пароль", { text: "hunter2" });
    expect(secret.result.isError).toBe(true);
    expect(secret.result.text).toContain("Пароли и коды подтверждения не ввожу");
    expect(await lab.evalPage("document.querySelector('[name=pass]').value.length", "/login")).toBe(0);
    await act("click", "Войти");
    expect(lab.fixtures.events("login_submit")).toMatchObject([{ detail: { login: "tester", passwordFilled: false } }]);
  });

  it("iframe: ref рамки (f<id>e..) кликает во внутренней рамке, ref страницы — во внешней", async () => {
    const snap = await openAndInspect(lab, "/frame");
    const els = snapshotElements(snap);
    const inner = els.find((e) => e.name === "Открыть панель в рамке");
    expect(inner?.frameId).toBeGreaterThan(0);
    expect(inner?.ref).toMatch(new RegExp(`^f${inner?.frameId}e\\d+_\\d+$`, "u"));
    expect(els.find((e) => e.name === "Внешняя кнопка")?.frameId).toBeUndefined();
    await act("click", "Открыть панель в рамке");
    expect(lab.fixtures.events().map((e) => e.kind)).toEqual(["inner_clicked"]);
    await act("click", "Внешняя кнопка");
    expect(lab.fixtures.events().map((e) => e.kind)).toEqual(["inner_clicked", "outer_clicked"]);
  });

  it("динамика: до подгрузки кнопки нет, после — есть; клик подгружает список, чтение это видит", async () => {
    await lab.tool("browser_open", { url: lab.url("/dynamic") });
    let snap = await lab.tool("browser_inspect", {});
    for (let i = 0; i < 20 && !snap.result.text.includes("Загрузить ещё"); i += 1) {
      await new Promise((r) => setTimeout(r, 300));
      snap = await lab.tool("browser_inspect", {});
    }
    expect(snap.result.text).toContain('"name":"Загрузить ещё"');
    await act("click", "Загрузить ещё");
    for (let i = 0; i < 20 && lab.fixtures.events("items_loaded").length === 0; i += 1) await new Promise((r) => setTimeout(r, 200));
    expect(lab.fixtures.events("items_loaded")).toMatchObject([{ detail: { count: 3 } }]);
    expect((await lab.tool("browser_read", {})).result.text).toContain("Позиция 4");
  });
});
