import { afterAll, beforeAll, expect, it } from "vitest";
import { type BrowserLab, startBrowserLab } from "./browser-lab.js";
import { liveSuite, openAndInspect, snapshotElements } from "./test-support.js";

liveSuite("browser reset завершает закрытие вкладок до следующего инструмента", () => {
  let lab: BrowserLab;
  beforeAll(async () => { lab = await startBrowserLab(); }, 120_000);
  afterAll(async () => { await lab?.close(); }, 60_000);

  it("каждый сброс оставляет единственную пустую вкладку в chrome.tabs, следующий inspect видит новую страницу", async () => {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      await lab.reset();
      const tabs = await lab.browser.sw("chrome.tabs.query({}).then(tabs => tabs.map(tab => ({ url: tab.url, pendingUrl: tab.pendingUrl })))");
      expect(tabs, `reset ${iteration}`).toEqual([{ url: "about:blank" }]);
      const snapshot = await openAndInspect(lab, "/login");
      expect(snapshotElements(snapshot).map(element => element.name), `inspect ${iteration}`).toContain("Логин");
    }
  }, 60_000);
});
