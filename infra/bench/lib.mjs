// Стенд: API сценариев (node --test infra/bench/scenarios/). Стенд поднимается один раз и остаётся жить (ensureUp);
// сценарии сериализуются межпроцессным замком (node --test гоняет файлы параллельно); каждый — со своим run.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DISPLAY, paths } from "./config.mjs";
import { cdp, resetTabs } from "./chrome.mjs";
import { control, events, server } from "./client.mjs";
import { alive, sleep, waitFor } from "./proc.mjs";
import { up } from "./stack.mjs";
import { status } from "./status.mjs";

export { cdp, sleep };

/** Поднять стенд, если не поднят (и оставить жить). Возвращает статус. */
export async function ensureUp() {
  const st = await status();
  if (st.ready) return st;
  // Процессы живы, но расширение переподключается (MV3 service worker засыпает) — ждём, а не перезапускаем.
  if (st.up && (await waitFor(async () => (await status()).ready, 30_000, 500))) return status();
  await up({ quiet: true });
  const again = await status();
  if (!again.ready) throw new Error(`стенд не готов: ${JSON.stringify({ ext: again.ext, sites: again.sites, healthz: again.healthz })}`);
  return again;
}

/** Межпроцессный замок стенда (mkdir атомарен). Протухший (pid мёртв) — снимается. Возвращает release(). */
export async function lock(timeoutMs = 600_000) {
  const dir = paths().lock;
  mkdirSync(paths().root, { recursive: true });
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(process.pid));
      return () => rmSync(dir, { recursive: true, force: true });
    } catch {
      let owner = 0;
      try {
        owner = Number(readFileSync(join(dir, "pid"), "utf8"));
      } catch {
        /* замок только что создаётся */
      }
      // Протух: владелец мёртв, либо pid так и не записан (упал между mkdir и записью) дольше 10 с.
      const age = (() => {
        try {
          return Date.now() - statSync(dir).mtimeMs;
        } catch {
          return 0;
        }
      })();
      if ((owner && !alive(owner)) || (!owner && age > 10_000)) rmSync(dir, { recursive: true, force: true });
      if (Date.now() > until) throw new Error("замок стенда занят слишком долго");
      await sleep(250);
    }
  }
}

export function newRun(prefix = "run") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Инструмент через НАСТОЯЩИЙ dispatchTool. confirm: "yes"|"no"|"expire"|"undelivered"|массив (деф "no"). */
export async function tool(name, input = {}, { confirm } = {}) {
  const r = await server("POST", "/dev/bench/tool", { name, input, ...(confirm ? { confirm } : {}) });
  if (r.status !== 200) throw new Error(`/dev/bench/tool ${name}: ${r.status} ${r.error ?? ""} ${JSON.stringify(r.unresolved ?? "")}`);
  return r;
}

/** Реплика через НАСТОЯЩУЮ петлю со сценарным мозгом. vars: {{var}} в сценарии. */
export async function say(text, script, { confirm, vars = {}, timeoutMs = 120_000 } = {}) {
  let raw = JSON.stringify(script);
  for (const [k, v] of Object.entries(vars)) raw = raw.replaceAll(`{{${k}}}`, String(v));
  const r = await server("POST", "/dev/bench/say", { text, script: JSON.parse(raw), timeoutMs, ...(confirm ? { confirm } : {}) }, timeoutMs + 30_000);
  if (r.status !== 200) throw new Error(`/dev/bench/say: ${r.status} ${r.error ?? ""}`);
  return r;
}

/** Факты журнала фикстур по run (и типу). */
export async function facts(run, type) {
  return events({ run, kind: "fact", type });
}

export async function traces(run, type) {
  return events({ run, kind: "trace", type });
}

/** Дождаться ≥ n фактов (или вернуть сколько есть по таймауту). Для «ничего не произошло» — n=Infinity, ms=1500. */
export async function waitFacts(run, type, n = 1, ms = 5_000) {
  let got = [];
  await waitFor(async () => (got = await facts(run, type)).length >= n, ms, 150);
  return got;
}

/** Скриншот экрана Xvfb (PNG). */
export function shot(file = join(paths().shots, `${Date.now()}.png`)) {
  mkdirSync(paths().shots, { recursive: true });
  execFileSync("import", ["-display", DISPLAY, "-window", "root", file], { stdio: "ignore" });
  return file;
}

/** Сброс: журнал фикстур, вкладки (одна about:blank), bench-сессия (ref-снимки, цель вкладки, одобрения). */
export async function reset() {
  await control("POST", "/reset");
  await resetTabs().catch(() => {});
  await server("POST", "/dev/bench/reset", {});
}

/** Типовой каркас сценария: стенд + замок + сброс. Возвращает release. */
export async function begin() {
  await ensureUp();
  const release = await lock();
  await reset();
  return release;
}

/** Открыть страницу фикстуры через browser_open и дождаться, пока вкладка ЗАКОММИТИТ навигацию на этот хост (иначе
 *  поиск вкладки по хосту сразу после open видит about:blank — это отдельный дефект, см. scenarios/defects.mjs). */
export async function open(url, { waitMs = 10_000, fresh = true } = {}) {
  // browser_open ФОКУСИРУЕТ уже открытую вкладку сайта (не перезагружает с новым ?run=) — для чистого сценария
  // закрываем всё лишнее заранее.
  if (fresh) await resetTabs();
  const r = await tool("browser_open", { url });
  if (r.result.isError) throw new Error(`browser_open ${url}: ${r.result.text}`);
  const origin = new URL(url).origin;
  // chrome.tabs url (список browser_tabs) — ЗАКОММИЧЕННЫЙ адрес вкладки (pendingUrl туда не попадает).
  await waitFor(async () => (await tool("browser_tabs", {})).result.text.includes(origin), waitMs, 150);
  return r;
}
