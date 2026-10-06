/**
 * БРАУЗЕРНАЯ ЛАБОРАТОРИЯ: изолированный лаб-сервер + лаб-копия расширения в headless-Chrome с временным профилем + сервер
 * фикстур. Инструменты `browser_*` идут через НАСТОЯЩИЙ dispatchTool лаб-сервера (`/dev/bench/tool`) в живое расширение.
 * Боевой Джарвис владельца (8787, его Chrome и профиль) не затрагивается: расширение собрано на порт лаборатории,
 * браузер — отдельный процесс, гасится по своему pid.
 */
import { pathToFileURL } from "node:url";
import type { LabServerHandle, LabServerStartOptions } from "../lib/server.js";
import { startLabServer } from "../lib/server.js";
import { removeRunDir } from "../lib/server-dir.js";
import { labRoot } from "../lib/server-state.js";
import { sleep } from "../lib/server-proc.js";
import { repoRoot } from "../lib/deps.js";
import { type BenchState, type BenchToolOpts, type BenchToolReply, benchReset, benchState, callBenchTool } from "./bench-client.js";
import { launchBrowser, type LabBrowser } from "./chrome-launcher.js";
import { buildLabExtension, type LabExtension } from "./ext-build.js";
import { describeProbe, findChromium, probeChromium, type ChromiumInfo } from "./find-chromium.js";
import { type FixtureServer, startFixtures } from "./fixture-server.js";
import { evalInPage, pages, screenshotPage, type PageInfo } from "./page-probe.js";

/** Имена хостов фикстур. Реальных сайтов за ними нет: резолвит браузер (MAP -> фикстуры), а DNS-суд сервера — таблица. */
export const LAB_HOSTS = {
  site: "site.lab.test",
  shop: "shop.lab.test",
  /** Опасный хост из списка §14 (банк): гейт сервера судит по имени ДО клика. */
  bank: "online.sberbank.ru",
} as const;

/** Публичный адрес из TEST-NET-3 (RFC 5737): DNS-суд считает его публичным, но в интернете он никуда не ведёт. */
const PUBLIC_ADDR = "203.0.113.10";
/** Имя, что «указывает во внутреннюю сеть»: для проверки SSRF-суда по ответу DNS. Браузеру оно не отдано. */
export const INTERNAL_HOST = "internal.lab.test";

export class NoBrowserError extends Error {}

export interface BrowserLabOptions {
  chrome?: ChromiumInfo;
  /** Дополнительные записи DNS-таблицы лаб-сервера (имя -> адреса). */
  dns?: Record<string, string[]>;
  server?: Pick<LabServerStartOptions, "keepDir" | "startupTimeoutMs">;
}

export interface BrowserLab {
  server: LabServerHandle;
  fixtures: FixtureServer;
  browser: LabBrowser;
  ext: LabExtension;
  /** http://<хост>/<путь> — адрес, по которому страницу откроет браузер лаборатории. */
  url(path: string, host?: string): string;
  /** Инструмент через настоящий dispatchTool лаб-сервера. */
  tool(name: string, input?: Record<string, unknown>, opts?: BenchToolOpts): Promise<BenchToolReply>;
  state(): Promise<BenchState>;
  pages(): Promise<PageInfo[]>;
  /** Выражение в странице (прямое наблюдение DOM мимо расширения). */
  evalPage(expression: string, urlPart?: string): Promise<unknown>;
  screenshot(urlPart?: string): Promise<Buffer>;
  /** Чистый лист: bench-сессия сервера, журнал фикстур, все вкладки закрыты. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const dnsTable = (extra: Record<string, string[]> = {}): Record<string, string[]> => ({
  ...Object.fromEntries(Object.values(LAB_HOSTS).map((h) => [h, [PUBLIC_ADDR]])),
  [INTERNAL_HOST]: ["10.0.0.5"],
  ...extra,
});

/** Дождаться, пока расширение подключится к /ext лаб-сервера (пиннинг пройден, ExtAdmission допустил). */
async function waitExtConnected(server: LabServerHandle, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await benchState(server).catch(() => null))?.ext.connected) return;
    await sleep(200);
  }
  const tail = server.logTail(40).split("\n").filter((l) => /ext|расширени|Origin/iu.test(l)).slice(-8).join("\n");
  throw new Error(`расширение не подключилось к /ext лаб-сервера за ${ms / 1000} с. Строки лога сервера:\n${tail || "(про /ext ничего нет)"}`);
}

export async function startBrowserLab(opts: BrowserLabOptions = {}): Promise<BrowserLab> {
  const probe = probeChromium();
  const chrome = opts.chrome ?? probe.found;
  if (!chrome) throw new NoBrowserError(describeProbe(probe));
  const undo: Array<() => Promise<unknown>> = [];
  const teardown = async (): Promise<void> => {
    // Идемпотентно: обратный порядок, каждое действие один раз (close() после исключения не гасит дважды).
    for (let f = undo.pop(); f; f = undo.pop()) await f().catch(() => undefined);
  };
  try {
    const fixtures = await startFixtures();
    undo.push(() => fixtures.close());
    const preload = pathToFileURL(repoRoot("infra/lab/browser/dns-preload.mjs")).href;
    const server = await startLabServer({
      ...opts.server,
      brain: "off",
      env: { NODE_OPTIONS: `--import=${preload}`, LAB_DNS_TABLE: JSON.stringify(dnsTable(opts.dns)) },
    });
    undo.push(() => server.stop());
    const extDir = `${labRoot()}/ext-${server.id}`;
    const ext = await buildLabExtension({ port: server.port, dir: extDir });
    undo.push(() => removeRunDir(extDir));
    const browser = await launchBrowser({ chrome, ext, dir: `${labRoot()}/chrome-${server.id}`, fixtureHosts: Object.values(LAB_HOSTS), fixturePort: fixtures.port });
    undo.push(() => browser.close());
    await waitExtConnected(server, 20_000);
    return {
      server, fixtures, browser, ext,
      url: (path, host = LAB_HOSTS.site) => `http://${host}${path}`,
      tool: (name, input, o) => callBenchTool(server, name, input, o),
      state: () => benchState(server),
      pages: () => pages(browser.cdp),
      evalPage: (expr, urlPart) => evalInPage(browser.cdp, expr, urlPart),
      screenshot: (urlPart) => screenshotPage(browser.cdp, urlPart),
      async reset() {
        await benchReset(server);
        const old = await pages(browser.cdp);
        await browser.cdp.send("Target.createTarget", { url: "about:blank" }); // сначала новая: браузер без вкладок мог бы завершиться
        for (const p of old) await browser.cdp.send("Target.closeTarget", { targetId: p.targetId });
        fixtures.reset();
      },
      close: teardown,
    };
  } catch (e) {
    await teardown();
    throw e;
  }
}

export { findChromium };
