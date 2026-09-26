// Стенд: HTTPS-сервер фикстур на 127.0.0.1:443. Сайт выбирается по заголовку Host (hosts.json), статика — из
// sites/<site>/, действия — sites/<site>/api.mjs (пишут ФАКТЫ в журнал), /media/* — из каталога стенда (Range для
// видео), /__bench/* — общий скрипт страниц и приём трасс. Запуск: node sites-server.mjs (пути — из config).
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import https from "node:https";
import { extname, join, normalize } from "node:path";
import { HERE, PORTS, hosts, paths } from "./config.mjs";
import { Journal, startControl } from "./sites-journal.mjs";

const p = paths();
const HOSTS = hosts();
const journal = new Journal(p.events);
const apis = {};
for (const site of new Set(Object.values(HOSTS))) {
  const f = join(HERE, "sites", site, "api.mjs");
  if (existsSync(f)) apis[site] = await import(f);
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webm": "video/webm", ".png": "image/png", ".svg": "image/svg+xml" };

function readBody(req) {
  return new Promise((res) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= 1_000_000) chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return res({});
      try {
        return res(JSON.parse(raw));
      } catch {
        return res(Object.fromEntries(new URLSearchParams(raw)));
      }
    });
    req.on("error", () => res({}));
  });
}

function sendFile(req, res, file) {
  const size = statSync(file).size;
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (m) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size, "cache-control": "no-store" });
  return createReadStream(file).pipe(res);
}

/** Файл внутри корня (без выхода за него через ..). */
function inside(root, rel) {
  const f = normalize(join(root, rel));
  return f.startsWith(root) && existsSync(f) && statSync(f).isFile() ? f : null;
}

async function handle(req, res) {
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  const site = HOSTS[host];
  const u = new URL(req.url, `https://${host || "unknown"}`);
  if (!site) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end(`стенд: неизвестный хост ${host}`);
  }
  const body = req.method === "POST" ? await readBody(req) : {};
  const cookieRun = /(?:^|;\s*)bench_run=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  const run = String(u.searchParams.get("run") ?? body.run ?? (cookieRun ? decodeURIComponent(cookieRun) : ""));
  let aborted = false;
  res.on("close", () => {
    if (!res.writableEnded) aborted = true;
  });
  const h = {
    host, site, run, body, url: u, path: u.pathname, query: u.searchParams, req, res,
    fact: (type, data = {}) => journal.add({ kind: "fact", host, site, run, type, data }),
    trace: (type, data = {}) => journal.add({ kind: "trace", host, site, run, type, data }),
    aborted: () => aborted,
    html: (code, html) => (res.writeHead(code, { "content-type": TYPES[".html"], "cache-control": "no-store" }), res.end(html)),
    json: (obj, code = 200) => (res.writeHead(code, { "content-type": TYPES[".json"], "cache-control": "no-store" }), res.end(JSON.stringify(obj))),
    redirect: (loc) => (res.writeHead(303, { location: loc }), res.end()),
  };
  if (u.pathname === "/__bench/trace" && req.method === "POST") {
    h.trace(String(body.type ?? "event"), { ...(body.data ?? {}), path: body.path });
    return h.json({ ok: true });
  }
  if (u.pathname.startsWith("/__bench/")) {
    const f = inside(join(HERE, "sites", "common"), u.pathname.slice("/__bench/".length));
    return f ? sendFile(req, res, f) : h.json({ ok: false }, 404);
  }
  if (u.pathname.startsWith("/media/")) {
    const f = inside(p.media, u.pathname.slice("/media/".length));
    return f ? sendFile(req, res, f) : h.json({ ok: false, error: "нет медиа" }, 404);
  }
  if (apis[site] && (await apis[site].handle(h))) return undefined;
  const rel = u.pathname.endsWith("/") ? `${u.pathname}index.html` : u.pathname;
  const f = inside(join(HERE, "sites", site), rel);
  if (f && !f.endsWith(".mjs")) return sendFile(req, res, f);
  return h.html(404, `<!doctype html><meta charset="utf-8"><title>404</title><h1>Не найдено</h1><p>${u.pathname}</p>`);
}

const { key, cert } = { key: readFileSync(join(p.certs, "key.pem")), cert: readFileSync(join(p.certs, "cert.pem")) };
https
  .createServer({ key, cert }, (req, res) =>
    handle(req, res).catch((e) => {
      console.error("sites: ошибка", e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }),
  )
  .listen(PORTS.sites, "127.0.0.1", () => console.log(`sites: https 127.0.0.1:${PORTS.sites}`, Object.keys(HOSTS).join(", ")));
startControl(journal, PORTS.control, () => ({ hosts: HOSTS, pid: process.pid }));
console.log(`sites: control http 127.0.0.1:${PORTS.control}`);
