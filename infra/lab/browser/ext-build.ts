/**
 * Лабораторная КОПИЯ расширения «Jarvis Web Hands»: адрес сервера зашит константой `WS_URL` в background.js (порт 8787 —
 * БОЕВОЙ сервер владельца), настроить его нельзя. Продукт не правим и в его dist не пишем: собираем тем же esbuild
 * (iife, es2022 — как apps/client/scripts/build.mjs), но подменяем строку при загрузке модуля, а результат кладём в
 * %TEMP%/jarvis-lab/ext-<id>. Манифест копируется как есть: `key` даёт тот же ID, что пиннит сервер на /ext.
 * Не нашли строку или в бандле остался боевой адрес — ОТКАЗ: лучше не собрать, чем подключить копию к боевому серверу.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { extIdFromManifestKey } from "../../../apps/server/src/gateway/ext-id.js";
import { repoRoot, requireFromClient } from "../lib/deps.js";
import { MARKER } from "../lib/server-dir.js";
import { LAB_PORT_MAX, LAB_PORT_MIN, LIVE_PORT } from "../lib/server-proc.js";

/** Строка боевого адреса в исходнике расширения (её же ищет ext-harness продукта). */
export const PROD_WS_LINE = 'const WS_URL = "ws://127.0.0.1:8787/ext";';
const PROD_ADDR = `127.0.0.1:${LIVE_PORT}/ext`;

/** Минимум esbuild, который нужен здесь (типы пакета лежат у клиента и из infra/lab не видны). */
interface EsbuildLike {
  build(o: Record<string, unknown>): Promise<unknown>;
}
interface OnLoadHost {
  onLoad(opts: { filter: RegExp }, cb: (a: { path: string }) => { contents: string; loader: string; resolveDir: string } | undefined): void;
}

export interface LabExtension {
  /** Распакованное расширение: сюда указывает Extensions.loadUnpacked. */
  dir: string;
  /** ID из `key` манифеста = тот, что пиннит /ext сервера (JARVIS_EXT_ID не нужен). */
  extId: string;
  port: number;
  wsUrl: string;
}

export interface ExtBuildOptions {
  /** Порт ЛАБ-сервера (8811..8899). */
  port: number;
  /** Каталог сборки (ASCII, в %TEMP%/jarvis-lab). */
  dir: string;
  /** Исходники расширения (тесты подсовывают копию без WS_URL). По умолчанию apps/extension. */
  srcDir?: string;
}

/** Порт допустим для лаб-копии: только диапазон лаборатории, НИКОГДА боевой. */
export function assertLabPort(port: number): void {
  if (port === LIVE_PORT) throw new Error(`порт ${LIVE_PORT} — БОЕВОЙ сервер владельца: лаб-копия расширения к нему не подключается`);
  if (!Number.isInteger(port) || port < LAB_PORT_MIN || port > LAB_PORT_MAX) throw new Error(`порт ${port} вне диапазона лаборатории ${LAB_PORT_MIN}..${LAB_PORT_MAX}`);
}

/** Проверка ГОТОВОГО бандла: свой адрес есть, боевого нет. Отдельно от сборки — чтобы её нельзя было обойти. */
export function assertLabBundle(bundle: string, port: number): void {
  if (bundle.includes(PROD_ADDR)) throw new Error(`в лаб-бандле остался боевой адрес ${PROD_ADDR} — не подключаю`);
  if (!bundle.includes(`ws://127.0.0.1:${port}/ext`)) throw new Error(`в лаб-бандле нет адреса ws://127.0.0.1:${port}/ext`);
}

export async function buildLabExtension(o: ExtBuildOptions): Promise<LabExtension> {
  assertLabPort(o.port);
  const srcDir = resolve(o.srcDir ?? repoRoot("apps/extension"));
  const entry = resolve(srcDir, "background.js");
  const original = readFileSync(entry, "utf8");
  if (!original.includes(PROD_WS_LINE)) throw new Error("строка WS_URL в background.js не найдена (константу поменяли?) — не рискую собрать копию, что глянет на боевой порт");
  const wsUrl = `ws://127.0.0.1:${o.port}/ext`;
  const patched = original.replace(PROD_WS_LINE, `const WS_URL = "${wsUrl}";`);
  const manifest = readFileSync(resolve(srcDir, "manifest.json"), "utf8");
  const key = (JSON.parse(manifest) as { key?: string }).key;
  if (!key) throw new Error("в manifest.json нет `key`: ID копии не совпадёт с пиннингом /ext");
  const outfile = resolve(o.dir, "dist/background.js");
  mkdirSync(resolve(o.dir, "dist"), { recursive: true });
  const { build } = requireFromClient("esbuild") as EsbuildLike;
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile,
    logLevel: "silent",
    plugins: [{ name: "lab-ws-url", setup: (b: OnLoadHost) => b.onLoad({ filter: /background\.js$/u }, (a) => (resolve(a.path) === entry ? { contents: patched, loader: "js", resolveDir: srcDir } : undefined)) }],
  });
  assertLabBundle(readFileSync(outfile, "utf8"), o.port);
  writeFileSync(resolve(o.dir, "manifest.json"), manifest);
  writeFileSync(resolve(o.dir, MARKER), "lab-extension");
  return { dir: o.dir.split("\\").join("/"), extId: extIdFromManifestKey(key), port: o.port, wsUrl };
}
