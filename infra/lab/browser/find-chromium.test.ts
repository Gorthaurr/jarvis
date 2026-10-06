import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeProbe, probeChromium, versionNear } from "./find-chromium.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "lab-fc-"));
  dirs.push(d);
  return d;
};
const touch = (p: string): void => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Окружение без Program Files: находка определяется только тем, что положил тест. */
const bareEnv = (over: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ProgramFiles: "Z:/нет", "ProgramFiles(x86)": "Z:/нет", ...over });

describe("разведка Chromium", () => {
  it("CHROME_PATH идёт первым, если файл есть", () => {
    const exe = join(tmp(), "chrome.exe");
    touch(exe);
    const p = probeChromium(bareEnv({ CHROME_PATH: exe }));
    expect(p.found).toMatchObject({ path: exe, source: "CHROME_PATH", kind: "chrome" });
    expect(p.tried[0]).toMatchObject({ source: "CHROME_PATH", exists: true });
  });

  it("CHROME_PATH указывает в пустоту — это видно в tried, поиск идёт дальше, а не падает", () => {
    const local = tmp();
    touch(join(local, "ms-playwright/chromium-1200/chrome-win/chrome.exe"));
    const p = probeChromium(bareEnv({ CHROME_PATH: "Z:/нет/chrome.exe", LOCALAPPDATA: local }));
    expect(p.tried[0]).toMatchObject({ source: "CHROME_PATH", exists: false });
    expect(p.found?.source).toBe("playwright");
  });

  it("из кэша Playwright берётся самая свежая сборка (по номеру ревизии), раньше установленного Chrome", () => {
    const local = tmp();
    touch(join(local, "ms-playwright/chromium-1100/chrome-win/chrome.exe"));
    touch(join(local, "ms-playwright/chromium-1200/chrome-win/chrome.exe"));
    const found = probeChromium(bareEnv({ LOCALAPPDATA: local })).found;
    expect(found?.path.replace(/\\/gu, "/")).toContain("chromium-1200");
    expect(found?.kind).toBe("chromium");
  });

  it("ничего нет: found=null, причина называет источники и подсказывает CHROME_PATH", () => {
    const p = probeChromium(bareEnv({}), () => false);
    expect(p.found).toBeNull();
    expect(p.tried.length).toBeGreaterThan(3);
    const why = describeProbe(p);
    expect(why).toContain("CHROME_PATH");
    expect(why).toContain("Program Files");
  });

  it("Edge — последний резерв: при наличии Chrome не выбирается", () => {
    const seen = probeChromium(bareEnv({}), () => true);
    expect(seen.found?.kind).not.toBe("edge");
    const onlyEdge = probeChromium(bareEnv({}), (path) => path.endsWith("msedge.exe"));
    expect(onlyEdge.found?.kind).toBe("edge");
  });

  it("версия — из соседней папки установки, числовая сортировка (154 > 99)", () => {
    const root = tmp();
    for (const v of ["99.0.0.1", "154.0.8037.58", "Dictionaries", "1.2.3"]) mkdirSync(join(root, v));
    expect(versionNear(join(root, "chrome.exe"))).toBe("154.0.8037.58");
    expect(versionNear(join(tmp(), "chrome.exe"))).toBe("");
  });
});
