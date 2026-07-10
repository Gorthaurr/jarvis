import { describe, expect, it } from "vitest";
import {
  BROWSER_INTENTS,
  CdpBrowserController,
  buildActScript,
  buildReadScript,
  cdpCommand,
  chromeCandidates,
  safeBrowserUrl,
} from "./browser-cdp.js";

describe("browser-cdp (§6) — построители и валидация", () => {
  it("chromeCandidates содержит пути к chrome/edge", () => {
    const c = chromeCandidates();
    expect(c.length).toBeGreaterThan(0);
    expect(c.some((p) => p.toLowerCase().includes("chrome.exe"))).toBe(true);
    expect(c.some((p) => p.toLowerCase().includes("msedge.exe"))).toBe(true);
  });

  it("cdpCommand формирует JSON-RPC", () => {
    expect(cdpCommand(7, "Page.navigate", { url: "x" })).toEqual({ id: 7, method: "Page.navigate", params: { url: "x" } });
    expect(cdpCommand(1, "Page.enable")).toEqual({ id: 1, method: "Page.enable" });
  });

  it("buildReadScript читает заголовок/url/текст страницы", () => {
    const s = buildReadScript();
    expect(s).toContain("document.title");
    expect(s).toContain("location.href");
    expect(s).toContain("innerText");
  });

  it("buildActScript покрывает интенты и не интерполирует данные как код (анти-инъекция)", () => {
    expect(buildActScript("scroll")).toContain("scrollBy");
    expect(buildActScript("back")).toContain("history.back");
    expect(buildActScript("play")).toContain(".play()");
    expect(buildActScript("click", { text: "Отправить" })).toContain("byText");
    // Опасный текст должен попасть в скрипт ТОЛЬКО как JSON-литерал, не как код.
    const evil = "'); alert(1); ('";
    const script = buildActScript("click", { text: evil });
    expect(script).toContain(JSON.stringify({ text: evil })); // данные — чистый JSON
    expect(script).toContain('const I = "click"'); // интент — тоже литерал
  });

  it("act с неизвестным интентом отклоняется ДО запуска браузера", async () => {
    const ctrl = new CdpBrowserController();
    await expect(ctrl.act("rm-rf")).rejects.toThrow(/неизвестный интент/);
  });

  it("BROWSER_INTENTS — ожидаемый набор", () => {
    expect(BROWSER_INTENTS).toContain("click");
    expect(BROWSER_INTENTS).toContain("type");
    expect(BROWSER_INTENTS).toContain("scroll");
    expect(BROWSER_INTENTS).not.toContain("eval");
  });

  it("safeBrowserUrl пропускает http(s) и отклоняет опасные схемы", () => {
    expect(safeBrowserUrl("https://web.telegram.org/k/")).toBe("https://web.telegram.org/k/");
    expect(safeBrowserUrl("  http://example.com  ")).toBe("http://example.com");
    expect(safeBrowserUrl("example.com")).toBe("example.com"); // без схемы → трактуется как https
    expect(() => safeBrowserUrl("file:///C:/Users/anton/.ssh/id_rsa")).toThrow(/схема/);
    expect(() => safeBrowserUrl("chrome://settings")).toThrow(/схема/);
    expect(() => safeBrowserUrl("data:text/html,x")).toThrow(/схема/);
  });

  it("safeBrowserUrl отклоняет «-»-лидирующий аргумент (флаг-инъекция Chrome)", () => {
    // Chrome в argv принял бы «--load-extension=…» / «--proxy-server=…» за ФЛАГ, не URL.
    expect(() => safeBrowserUrl("--load-extension=/tmp/evil")).toThrow(/флаг/);
    expect(() => safeBrowserUrl("  --proxy-server=http://attacker")).toThrow(/флаг/);
    expect(() => safeBrowserUrl("-vfoo")).toThrow(/флаг/);
  });

  it("open() отклоняет опасный URL ДО запуска браузера", async () => {
    const ctrl = new CdpBrowserController();
    await expect(ctrl.open("file:///etc/passwd")).rejects.toThrow(/схема/);
    await expect(ctrl.open("--proxy-server=http://attacker")).rejects.toThrow(/флаг/);
  });
});
