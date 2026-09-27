// Стенд: подъём и гашение стека — Xvfb :99 → openbox → подготовка → фикстуры (HTTPS 443 + control) → сервер Джарвиса
// (8787, dev-HTTP) → Chromium с расширением → ждём коннект расширения. Порты/дисплей заняты чужими — отказ (не убиваем).
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DISPLAY, HERE, PORTS, SCREEN, SERVER_DIR, cleanEnv, findChrome, paths } from "./config.mjs";
import { chromeArgs, chromeEnv, cdp } from "./chrome.mjs";
import { control, healthz, readState, server, writeState } from "./client.mjs";
import { prepare, ensureDirs } from "./prepare.mjs";
import { alive, displayLock, lockDir, portFree, readPid, spawnDetached, stopByPid, waitFor } from "./proc.mjs";

export const PROCS = ["xvfb", "wm", "sites", "server", "chrome"];

const say = (msg) => process.stderr.write(`[bench] ${msg}\n`);

async function preflight(p) {
  const problems = [];
  for (const [name, port] of Object.entries(PORTS)) if (!(await portFree(port))) problems.push(`порт ${port} (${name}) занят`);
  const lock = displayLock(DISPLAY);
  if (lock.state === "busy") problems.push(`дисплей ${DISPLAY} занят (pid ${lock.pid})`);
  if (!findChrome()) problems.push("Chromium не найден (CHROME_PATH или /opt/pw-browsers/chromium-*)");
  if (problems.length) throw new Error(`стенд не поднят: ${problems.join("; ")} — чужое не трогаю (bench status / bench down)`);
}

export async function up(opts = {}) {
  // Подъём — под своим замком: два `up` наперегонки перезаписали бы pid-файлы друг друга (сироты вне `down`).
  ensureDirs(paths());
  const release = await lockDir(paths().upLock, 180_000, "подъём стенда");
  try {
    return await upInner(opts);
  } catch (e) {
    say(`подъём не удался — гашу поднятое (логи остаются в ${paths().logs})`);
    await down();
    throw e;
  } finally {
    release();
  }
}

async function upInner({ quiet = false } = {}) {
  const p = paths();
  ensureDirs(p);
  if (PROCS.every((n) => alive(readPid(p.run, n)))) {
    if (!quiet) say("стенд уже поднят");
    // Коннект расширения — живой, не из state.json (MV3 service worker мог уснуть/отвалиться).
    const ext = await server("GET", "/dev/bench/state", undefined, 5_000).catch(() => null);
    return { ...readState(p), extConnected: ext?.ext?.connected === true };
  }
  if (PROCS.some((n) => alive(readPid(p.run, n)))) await down();
  await preflight(p);
  const log = (n) => join(p.logs, `${n}.out.log`);
  const pids = {};
  pids.xvfb = spawnDetached(p.run, "xvfb", "Xvfb", [DISPLAY, "-screen", "0", `${SCREEN.w}x${SCREEN.h}x24`, "-nolisten", "tcp", "-noreset"], { env: cleanEnv(), logFile: log("xvfb") });
  if (!(await waitFor(() => existsSync(`/tmp/.X11-unix/X${DISPLAY.slice(1)}`), 10_000))) throw new Error("Xvfb не поднялся (logs/xvfb.out.log)");
  pids.wm = spawnDetached(p.run, "wm", "openbox", ["--sm-disable"], { env: cleanEnv({ DISPLAY }), logFile: log("wm") });
  say("Xvfb + openbox подняты; готовлю сертификат, медиа, расширение, БД…");
  const { extId, token } = await prepare(p);
  pids.sites = spawnDetached(p.run, "sites", process.execPath, [join(HERE, "sites-server.mjs")], { env: cleanEnv({ BENCH_DIR: p.root }), logFile: log("sites") });
  if (!(await waitFor(async () => (await control("GET", "/health")).ok, 10_000))) throw new Error("фикстуры не поднялись (logs/sites.out.log)");
  pids.server = spawnDetached(p.run, "server", process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: cleanEnv({ JARVIS_ENV_PATH: p.env }),
    logFile: log("server"),
  });
  say("сервер Джарвиса стартует (до 90 с)…");
  if (!(await waitFor(() => healthz(), 90_000, 500))) throw new Error("сервер не ответил на /healthz за 90 с (logs/server.out.log)");
  rmSync(p.profile, { recursive: true, force: true });
  pids.chrome = spawnDetached(p.run, "chrome", findChrome(), chromeArgs(p), { env: chromeEnv(cleanEnv()), logFile: log("chrome") });
  if (!(await waitFor(() => cdp.version(), 20_000))) throw new Error("Chromium не открыл CDP (logs/chrome.out.log)");
  const state = { startedAt: new Date().toISOString(), dir: p.root, extId, token, pids, chrome: findChrome(), ports: PORTS, display: DISPLAY };
  writeState(p, state);
  const ext = await waitFor(async () => (await server("GET", "/dev/bench/state")).ext?.connected, 30_000, 300);
  if (!ext) {
    const sw = await cdp.swAlive(extId).catch(() => false);
    say(`ВНИМАНИЕ: расширение не подключилось к /ext за 30 с (service worker ${sw ? "жив" : "НЕ найден"}) — см. logs/server.out.log`);
  } else say("расширение подключено — стенд готов");
  return { ...state, extConnected: Boolean(ext) };
}

export async function down() {
  const p = paths();
  const stopped = {};
  for (const n of [...PROCS].reverse()) stopped[n] = await stopByPid(p.run, n);
  rmSync(p.state, { force: true });
  rmSync(p.profile, { recursive: true, force: true });
  return stopped;
}
