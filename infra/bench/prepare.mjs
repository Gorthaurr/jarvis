// Стенд: подготовка каталога перед `up` — сертификат на хосты фикстур, медиа, бандл расширения (ВНЕ дерева
// apps/extension), server.env (только существующие флаги; свежий dev-токен), миграции PGlite.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { EXT_SRC, PORTS, ROOT, cleanEnv, extIdFromManifest, hosts, paths } from "./config.mjs";

export function ensureDirs(p = paths()) {
  for (const d of [p.root, p.run, p.logs, p.data, p.ext, p.certs, p.media, p.shots, p.out]) mkdirSync(d, { recursive: true });
}

/** Самоподписанный сертификат с SAN на все хосты из hosts.json (перевыпуск, если список хостов изменился). */
export function ensureCert(p = paths()) {
  const names = Object.keys(hosts()).sort();
  const san = names.map((h) => `DNS:${h}`).join(",");
  const stamp = join(p.certs, "san.txt");
  const key = join(p.certs, "key.pem");
  const cert = join(p.certs, "cert.pem");
  if (existsSync(cert) && existsSync(key) && existsSync(stamp) && readFileSync(stamp, "utf8") === san) return { key, cert };
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-subj", "/CN=jarvis-bench", "-addext", `subjectAltName=${san}`, "-keyout", key, "-out", cert], { stdio: "ignore" });
  writeFileSync(stamp, san);
  return { key, cert };
}

/** Клип для фикстуры видео (10 с, VP8+Opus). Нет ffmpeg — фикстура честно покажет «нет клипа». */
export function ensureMedia(p = paths()) {
  const clip = join(p.media, "clip.webm");
  if (existsSync(clip)) return clip;
  try {
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-f", "lavfi", "-i", "sine=f=440", "-t", "10", "-c:v", "libvpx", "-b:v", "300k", "-c:a", "libopus", clip], { stdio: "ignore" });
  } catch {
    return null;
  }
  return clip;
}

/** Бандл service worker расширения тем же esbuild, что клиентский build.mjs, но в каталог стенда. */
export async function buildExtension(p = paths()) {
  const req = createRequire(join(ROOT, "apps", "client", "package.json"));
  const { build } = req("esbuild");
  mkdirSync(join(p.ext, "dist"), { recursive: true });
  await build({
    entryPoints: [join(EXT_SRC, "background.js")],
    outfile: join(p.ext, "dist", "background.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  copyFileSync(join(EXT_SRC, "manifest.json"), join(p.ext, "manifest.json"));
  return extIdFromManifest(join(p.ext, "manifest.json"));
}

/** server.env: только СУЩЕСТВУЮЩИЕ флаги (новых JARVIS_* стенд не вводит). Токен — новый на каждый up. */
export function writeServerEnv(p, extId) {
  const token = randomBytes(16).toString("hex");
  const lines = {
    PORT: PORTS.server,
    HOST: "127.0.0.1",
    JARVIS_DEV_HTTP: 1,
    JARVIS_DEV_TOKEN: token,
    JARVIS_EXT_ID: extId,
    JARVIS_DATA_DIR: p.data,
    DATABASE_URL: `pglite://${p.pgdata}`,
    JARVIS_SUBSCRIPTION_FALLBACK: 0,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_BASE_URL: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    STT_PROVIDER: "mock",
    JARVIS_SPEAKER_GATE: 0,
    JARVIS_AMBIENT_TELEGRAM: 0,
    JARVIS_AMBIENT_MAIL: 0,
    JARVIS_AMBIENT_CALENDAR: 0,
    JARVIS_SKILL_DISTILL: 0,
  };
  writeFileSync(p.env, `${Object.entries(lines).map(([k, v]) => `${k}=${v}`).join("\n")}\n`, { mode: 0o600 });
  return token;
}

export function migrate(p = paths()) {
  execFileSync(process.execPath, [join(ROOT, "infra", "migrate.mjs")], {
    cwd: ROOT,
    env: cleanEnv({ DATABASE_URL: `pglite://${p.pgdata}` }),
    stdio: ["ignore", "ignore", "pipe"],
  });
}

export async function prepare(p = paths()) {
  ensureDirs(p);
  ensureCert(p);
  const clip = ensureMedia(p);
  const extId = await buildExtension(p);
  const token = writeServerEnv(p, extId);
  migrate(p);
  return { extId, token, clip };
}
