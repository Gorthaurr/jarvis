/**
 * Лаб-копия расширения: настоящая сборка esbuild во временный каталог. Главное — копия смотрит на порт ЛАБОРАТОРИИ,
 * ни при каких условиях не на боевой 8787, а продуктовый dist остаётся нетронутым.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JARVIS_WEB_HANDS_EXT_ID, pinnedExtIdOrDefault } from "../../../apps/server/src/gateway/ext-id.js";
import { repoRoot } from "../lib/deps.js";
import { MARKER } from "../lib/server-dir.js";
import { PROD_WS_LINE, assertLabBundle, assertLabPort, buildLabExtension } from "./ext-build.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "lab-eb-"));
  dirs.push(d);
  return d.split("\\").join("/");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const DIST = repoRoot("apps/extension/dist/background.js");
const sha = (): string => (existsSync(DIST) ? createHash("sha256").update(readFileSync(DIST)).digest("hex") : "нет");

describe("сборка лаб-копии расширения", () => {
  it("копия смотрит на порт лаборатории, боевого адреса в бандле нет, ID = пиннинг /ext, dist продукта не тронут", async () => {
    const before = sha();
    const out = tmp();
    const ext = await buildLabExtension({ port: 8842, dir: out });
    const bundle = readFileSync(`${out}/dist/background.js`, "utf8");
    expect(bundle).toContain('"ws://127.0.0.1:8842/ext"');
    expect(bundle).not.toContain("127.0.0.1:8787/ext");
    expect(ext).toMatchObject({ dir: out, port: 8842, wsUrl: "ws://127.0.0.1:8842/ext", extId: JARVIS_WEB_HANDS_EXT_ID });
    expect(ext.extId).toBe(pinnedExtIdOrDefault());
    expect(readFileSync(`${out}/manifest.json`, "utf8")).toBe(readFileSync(repoRoot("apps/extension/manifest.json"), "utf8"));
    expect(existsSync(`${out}/${MARKER}`)).toBe(true);
    expect(sha()).toBe(before);
  }, 30_000);

  it("бандл — рабочий SW: тело расширения (обработчики интентов) на месте, а не пустышка", async () => {
    const out = tmp();
    await buildLabExtension({ port: 8843, dir: out });
    const bundle = readFileSync(`${out}/dist/background.js`, "utf8");
    for (const intent of ["tab.openOrFocus", "tab.inspect", "tab.act", "tab.read", "tab.list"]) expect(bundle).toContain(intent);
    expect(bundle.length).toBeGreaterThan(50_000);
  }, 30_000);

  it("порт: боевой 8787 и всё вне 8811..8899 отклонены; границы диапазона допустимы", () => {
    expect(() => assertLabPort(8787)).toThrow(/БОЕВОЙ/u);
    for (const bad of [0, 80, 8810, 8900, 18787, 8811.5]) expect(() => assertLabPort(bad)).toThrow(/вне диапазона/u);
    for (const good of [8811, 8850, 8899]) expect(() => assertLabPort(good)).not.toThrow();
  });

  it("проверка бандла ловит боевой адрес и отсутствие своего (обойти её сборкой нельзя)", () => {
    expect(() => assertLabBundle(`var u = "ws://127.0.0.1:8787/ext"`, 8830)).toThrow(/боевой адрес/u);
    expect(() => assertLabBundle(`var u = "ws://127.0.0.1:8831/ext"`, 8830)).toThrow(/нет адреса/u);
    expect(() => assertLabBundle(`var u = "ws://127.0.0.1:8830/ext"`, 8830)).not.toThrow();
    // Даже если свой адрес есть, но боевой остался где-то ещё в коде — отказ.
    expect(() => assertLabBundle(`a("ws://127.0.0.1:8830/ext"); b("ws://127.0.0.1:8787/ext")`, 8830)).toThrow(/боевой адрес/u);
  });

  it("константу WS_URL не нашли (её переименовали) — отказ ДО сборки, ничего не пишется", async () => {
    const src = tmp();
    writeFileSync(`${src}/background.js`, 'const ADDRESS = "ws://127.0.0.1:8787/ext";\n');
    writeFileSync(`${src}/manifest.json`, JSON.stringify({ key: "AAAA" }));
    const out = `${tmp()}/ext`;
    await expect(buildLabExtension({ port: 8830, dir: out, srcDir: src })).rejects.toThrow(/WS_URL.*не найдена/u);
    expect(existsSync(out)).toBe(false);
  });

  it("в манифесте нет key — отказ: ID копии не совпал бы с пиннингом и /ext её не пустил бы", async () => {
    const src = tmp();
    writeFileSync(`${src}/background.js`, `${PROD_WS_LINE}\n`);
    writeFileSync(`${src}/manifest.json`, JSON.stringify({ name: "x" }));
    await expect(buildLabExtension({ port: 8830, dir: `${tmp()}/ext`, srcDir: src })).rejects.toThrow(/нет `key`/u);
  });

  it("подмена точечная: остальной код модуля не тронут, импорты собраны", async () => {
    const src = tmp();
    mkdirSync(`${src}/modules`);
    writeFileSync(`${src}/modules/greet.js`, 'export const greet = () => "привет-из-модуля";\n');
    writeFileSync(`${src}/background.js`, `import { greet } from "./modules/greet.js";\n${PROD_WS_LINE}\nglobalThis.out = [WS_URL, greet()];\n`);
    writeFileSync(`${src}/manifest.json`, JSON.stringify({ key: "AAAA" }));
    const out = tmp();
    await buildLabExtension({ port: 8850, dir: out, srcDir: src });
    const g: { out?: string[] } = {};
    new Function("globalThis", readFileSync(`${out}/dist/background.js`, "utf8"))(g);
    expect(g.out).toEqual(["ws://127.0.0.1:8850/ext", "привет-из-модуля"]);
  });
});
