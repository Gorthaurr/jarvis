/**
 * Предзагрузка DNS лаб-сервера: настоящий процесс Node с NODE_OPTIONS=--import (как у сервера) и проверка глобала, который
 * читает суд навигации сервера. Без этого шва SSRF-имена («указывает на 10.0.0.5») в лаборатории не воспроизвести.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../lib/deps.js";

const PRELOAD = pathToFileURL(repoRoot("infra/lab/browser/dns-preload.mjs")).href;

function lookupInChild(table: Record<string, string[]>, hosts: string[]): Array<string[] | string> {
  const code = `Promise.all(${JSON.stringify(hosts)}.map((h) => globalThis.__jarvisTestNavLookup(h).catch((e) => e.code))).then((r) => console.log(JSON.stringify(r)))`;
  const r = spawnSync(process.execPath, ["-e", code], {
    env: { ...process.env, NODE_OPTIONS: `--import=${PRELOAD}`, LAB_DNS_TABLE: JSON.stringify(table) },
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`дочерний процесс упал: ${r.stderr}`);
  return JSON.parse(r.stdout.trim()) as Array<string[] | string>;
}

describe("DNS-таблица лаб-сервера", () => {
  it("имя из таблицы даёт адреса, имени нет — ENOTFOUND (как NXDOMAIN), регистр не важен", () => {
    const out = lookupInChild({ "shop.lab.test": ["203.0.113.10"], "internal.lab.test": ["10.0.0.5"] }, ["shop.lab.test", "SHOP.LAB.TEST", "internal.lab.test", "нет.lab.test"]);
    expect(out).toEqual([["203.0.113.10"], ["203.0.113.10"], ["10.0.0.5"], "ENOTFOUND"]);
  });

});
