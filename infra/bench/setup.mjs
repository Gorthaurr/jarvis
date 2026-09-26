// Стенд: `bench setup` — системные зависимости (apt) и проверки окружения. Идемпотентно.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ROOT, findChrome } from "./config.mjs";

const APT = ["xvfb", "xdotool", "wmctrl", "openbox", "imagemagick", "tesseract-ocr", "tesseract-ocr-rus", "tesseract-ocr-eng", "ffmpeg", "x11-utils", "openssl"];
const BINS = { Xvfb: "xvfb", openbox: "openbox", xdotool: "xdotool", wmctrl: "wmctrl", import: "imagemagick", tesseract: "tesseract-ocr", ffmpeg: "ffmpeg", openssl: "openssl" };

function has(bin) {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function setup({ install = true } = {}) {
  const missing = Object.keys(BINS).filter((b) => !has(b));
  const log = [];
  if (missing.length && install) {
    if (process.getuid?.() !== 0) throw new Error(`нужен root для apt-get (нет: ${missing.join(", ")})`);
    log.push(`apt-get install: ${APT.join(" ")}`);
    execFileSync("apt-get", ["update", "-qq"], { stdio: "inherit" });
    execFileSync("apt-get", ["install", "-y", "--no-install-recommends", ...APT], { stdio: "inherit", env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" } });
  }
  const checks = {
    bins: Object.fromEntries(Object.keys(BINS).map((b) => [b, has(b)])),
    chromium: findChrome(),
    nodeModules: existsSync(join(ROOT, "node_modules")) && existsSync(join(ROOT, "apps", "server", "node_modules", "tsx")),
    esbuild: (() => {
      try {
        createRequire(join(ROOT, "apps", "client", "package.json")).resolve("esbuild");
        return true;
      } catch {
        return false;
      }
    })(),
    tesseractRus: (() => {
      try {
        return /\brus\b/.test(execFileSync("tesseract", ["--list-langs"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
      } catch {
        return false;
      }
    })(),
  };
  const ok = Object.values(checks.bins).every(Boolean) && Boolean(checks.chromium) && checks.nodeModules && checks.esbuild;
  return { ok, log, checks, hint: ok ? "дальше: node infra/bench/bench.mjs up" : "pnpm install --frozen-lockfile; CHROME_PATH=<chrome>; повтори setup" };
}
