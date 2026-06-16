/**
 * Сборка Electron-клиента через esbuild (§3).
 *
 * Три выходных бандла:
 *   - main/index.ts     -> dist/main/index.js     (CJS, platform=node, external: electron)
 *   - preload/index.ts  -> dist/preload/index.js  (CJS, platform=node, external: electron)
 *   - renderer/renderer.ts -> dist/renderer/renderer.js (IIFE, platform=browser)
 *
 * @jarvis/protocol и @jarvis/shared бандлятся внутрь (bundle:true) — это TS-исходники
 * в workspace, импортируемые по bare-спецификаторам. esbuild резолвит их через node_modules
 * симлинки pnpm. Нативный модуль ws помечаем external для main (резолвится в рантайме из node_modules).
 *
 * index.html и styles.css просто копируются в dist/renderer.
 */
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outdir = resolve(root, "dist");

/** Общие опции бандла. */
const common = {
  bundle: true,
  sourcemap: true,
  target: "es2022",
  logLevel: "info",
};

async function run() {
  // main-процесс: Node + Electron API. CJS-бандл с расширением .cjs — пакет помечен
  // "type":"module", поэтому .js трактовался бы как ESM и require() падал бы.
  await build({
    ...common,
    entryPoints: [resolve(root, "main/index.ts")],
    outfile: resolve(outdir, "main/index.cjs"),
    platform: "node",
    format: "cjs",
    external: ["electron", "ws"],
  });

  // preload: запускается в привилегированном контексте до renderer. Тоже .cjs (CJS).
  await build({
    ...common,
    entryPoints: [resolve(root, "preload/index.ts")],
    outfile: resolve(outdir, "preload/index.cjs"),
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });

  // renderer: обычный браузерный контекст (contextIsolation), без node-доступа.
  await build({
    ...common,
    entryPoints: [resolve(root, "renderer/renderer.ts")],
    outfile: resolve(outdir, "renderer/renderer.js"),
    platform: "browser",
    format: "iife",
  });

  // Статика renderer (включая AudioWorklet — он грузится как отдельный модуль, не бандлится).
  await mkdir(resolve(outdir, "renderer"), { recursive: true });
  await cp(resolve(root, "renderer/index.html"), resolve(outdir, "renderer/index.html"));
  await cp(resolve(root, "renderer/styles.css"), resolve(outdir, "renderer/styles.css"));
  await cp(resolve(root, "renderer/audio-worklet.js"), resolve(outdir, "renderer/audio-worklet.js"));

  // Шрифты (вариативные woff2 из node_modules в dist/renderer/fonts).
  const fontsOut = resolve(outdir, "renderer/fonts");
  await mkdir(fontsOut, { recursive: true });
  // Inter (резерв, latin + cyrillic).
  const interSrc = resolve(root, "node_modules/@fontsource-variable/inter/files");
  for (const [src, dst] of [
    ["inter-latin-wght-normal.woff2", "inter-latin.woff2"],
    ["inter-latin-ext-wght-normal.woff2", "inter-latin-ext.woff2"],
    ["inter-cyrillic-wght-normal.woff2", "inter-cyrillic.woff2"],
  ]) {
    await cp(resolve(interSrc, src), resolve(fontsOut, dst));
  }
  // Manrope (основной, latin + cyrillic). Если пакета нет — рестайл гладко откатится на Inter.
  const manropeSrc = resolve(root, "node_modules/@fontsource-variable/manrope/files");
  for (const [src, dst] of [
    ["manrope-latin-wght-normal.woff2", "manrope-latin.woff2"],
    ["manrope-cyrillic-wght-normal.woff2", "manrope-cyrillic.woff2"],
  ]) {
    await cp(resolve(manropeSrc, src), resolve(fontsOut, dst)).catch((e) => {
      console.warn(`[build] Manrope не скопирован (${dst}) — фолбэк на Inter:`, e.message);
    });
  }

  console.log("[build] клиент собран -> dist/");
}

run().catch((e) => {
  console.error("[build] ошибка сборки:", e);
  process.exit(1);
});
