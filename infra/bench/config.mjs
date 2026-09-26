// Стенд (W1): каталоги, порты, поиск Chromium, ID расширения, хосты фикстур — одно место на весь infra/bench.
// Каталог стенда: BENCH_DIR (или `--dir` у CLI) → иначе infra/bench/tmp (игнорируется git'ом правилом `tmp/`).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..", "..");
export const SERVER_DIR = join(ROOT, "apps", "server");
export const EXT_SRC = join(ROOT, "apps", "extension");

/** Порты: сервер ЗАШИТ в расширении (ws://127.0.0.1:8787/ext) — один стенд на контейнер. */
export const PORTS = { server: 8787, sites: 443, control: 8790, cdp: 9223 };
export const DISPLAY = ":99";
export const SCREEN = { w: 2560, h: 1440 };

export function benchDir() {
  return resolve(process.env.BENCH_DIR?.trim() || join(HERE, "tmp"));
}

export function paths(b = benchDir()) {
  return {
    root: b,
    run: join(b, "run"),
    logs: join(b, "logs"),
    data: join(b, "data"),
    pgdata: join(b, "pgdata"),
    ext: join(b, "ext"),
    profile: join(b, "chrome-profile"),
    certs: join(b, "certs"),
    media: join(b, "media"),
    shots: join(b, "shots"),
    out: join(b, "out"),
    state: join(b, "state.json"),
    env: join(b, "server.env"),
    events: join(b, "sites-events.jsonl"),
    lock: join(b, "lock"),
  };
}

/** Хост → сайт фикстуры (один источник: резолвер Chromium, SAN сертификата, маршрутизация сервера фикстур). */
export function hosts() {
  return JSON.parse(readFileSync(join(HERE, "sites", "hosts.json"), "utf8"));
}

/** Chromium: CHROME_PATH → старшая сборка Playwright в /opt/pw-browsers → системный. */
export function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = "/opt/pw-browsers";
  const builds = existsSync(base)
    ? readdirSync(base)
        .map((d) => /^chromium-(\d+)$/.exec(d))
        .filter(Boolean)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .map((m) => join(base, m[0], "chrome-linux", "chrome"))
    : [];
  return [...builds, "/usr/bin/chromium", "/usr/bin/google-chrome"].find((p) => existsSync(p)) ?? null;
}

/** ID распакованного расширения из `key` манифеста: sha256(DER) → первые 32 hex → 0-f ↦ a-p. */
export function extIdFromManifest(manifestPath = join(EXT_SRC, "manifest.json")) {
  const key = JSON.parse(readFileSync(manifestPath, "utf8")).key;
  if (!key) throw new Error("в manifest.json нет key — ID расширения зависел бы от пути");
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
}

/** Чистое окружение для дочерних процессов: без токенов агента, прокси и ANTHROPIC_* родителя. */
export function cleanEnv(extra = {}) {
  const keep = ["PATH", "HOME", "USER", "LANG", "TZ", "TMPDIR"];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { LANG: "C.UTF-8", ...env, ...extra };
}
