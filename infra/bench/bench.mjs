#!/usr/bin/env node
// Стенд Джарвиса (браузерный, W1): node infra/bench/bench.mjs <команда> — см. infra/bench/README.md.
//   setup | up | down | status | tool <name> <json|@file> [--confirm yes|no|expire|undelivered|yes,no] [--json] [--full]
//   say "реплика" --script f.json [--confirm …] [--var k=v] [--json] | shot [file.png] [--scale 50%] [--ocr]
//   log [n] [--out] | sites-log [--run id] [--site s] [--facts] [--json] | reset          Общий флаг: --dir <каталог>.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opts = {};
const pos = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (!a.startsWith("--")) pos.push(a);
  else if (["--json", "--full", "--ocr", "--out", "--facts"].includes(a)) opts[a.slice(2)] = true;
  else if (a === "--var") (opts.vars ??= {})[argv[i + 1].split("=")[0]] = argv[++i].split("=").slice(1).join("=");
  else opts[a.slice(2)] = argv[++i];
}
if (opts.dir) process.env.BENCH_DIR = opts.dir;

const { DISPLAY, paths } = await import("./config.mjs");
const { events, server } = await import("./client.mjs");
const lib = await import("./lib.mjs");
const view = await import("./view.mjs");
const print = (x) => console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));
const readJsonArg = (s) => JSON.parse(s?.startsWith("@") ? readFileSync(s.slice(1), "utf8") : (s ?? "{}"));
const confirm = opts.confirm?.includes(",") ? opts.confirm.split(",") : opts.confirm;

const commands = {
  async setup() {
    const { setup } = await import("./setup.mjs");
    print(setup());
  },
  async up() {
    const { up } = await import("./stack.mjs");
    const s = await up();
    print({ ok: true, dir: s.dir, extId: s.extId, extConnected: s.extConnected ?? true, display: s.display });
  },
  async down() {
    const { down } = await import("./stack.mjs");
    print({ ok: true, stopped: await down() });
  },
  async status() {
    const { status } = await import("./status.mjs");
    print(await status());
  },
  async tool() {
    const [name, json] = pos.slice(1);
    if (!name) throw new Error("tool <name> <json|@file>");
    const r = await server("POST", "/dev/bench/tool", { name, input: readJsonArg(json), ...(confirm ? { confirm } : {}) });
    if (r.status !== 200 || opts.json) return print(r);
    print(view.toolView(r, { full: opts.full }));
  },
  async say() {
    const text = pos[1];
    if (!text || !opts.script) throw new Error('say "реплика" --script file.json');
    const script = JSON.parse(readFileSync(opts.script, "utf8"));
    const r = await lib.say(text, script, { confirm, vars: opts.vars ?? {} });
    print(opts.json ? r : view.sayView(r));
  },
  async shot() {
    const file = lib.shot(pos[1]);
    if (opts.scale) execFileSync("convert", [file, "-resize", opts.scale, file]);
    print(file);
    if (opts.ocr) print(execFileSync("tesseract", [file, "-", "-l", "rus+eng"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  },
  async log() {
    const n = Number(pos[1] ?? 40);
    const p = paths();
    const day = new Date().toISOString().slice(0, 10);
    const file = opts.out ? join(p.logs, "server.out.log") : join(p.data, "logs", `server-${day}.log`);
    if (!existsSync(file)) throw new Error(`нет лога ${file}`);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n").slice(-n);
    print(opts.out ? lines.join("\n") : lines.map(view.logLine).join("\n"));
  },
  async "sites-log"() {
    const evs = await events({ run: opts.run, site: opts.site, kind: opts.facts ? "fact" : undefined });
    print(opts.json ? evs : evs.map(view.eventLine).join("\n") || "(журнал пуст)");
  },
  async reset() {
    await lib.reset();
    print({ ok: true, display: DISPLAY });
  },
};

const cmd = pos[0];
if (!commands[cmd]) {
  print(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 6).join("\n"));
  process.exit(cmd ? 2 : 0);
}
try {
  await commands[cmd]();
} catch (e) {
  console.error(`bench ${cmd}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
