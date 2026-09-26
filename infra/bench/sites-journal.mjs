// Стенд: журнал фикстур. Факт (kind:"fact") пишет СЕРВЕР фикстур, когда реально пришёл HTTP-запрос действия
// (отправлено/оплачено/заказ); трасса (kind:"trace") — то, что страница сама сообщила (клик, клавиша, page_view).
// Сценарии проверяют ФАКТ, а не слова модели. Хранилище: JSONL-файл + кольцо в памяти; control — HTTP на loopback.
import { appendFileSync, writeFileSync } from "node:fs";
import http from "node:http";

const RING = 5_000;

export class Journal {
  constructor(file) {
    this.file = file;
    this.ring = [];
    this.seq = 0;
  }

  add(ev) {
    const e = { seq: ++this.seq, ts: Date.now(), ...ev };
    this.ring.push(e);
    if (this.ring.length > RING) this.ring.shift();
    try {
      appendFileSync(this.file, `${JSON.stringify(e)}\n`);
    } catch {
      /* журнал на диске — удобство; кольцо в памяти — источник для сценариев */
    }
    return e;
  }

  query({ run, site, kind, type, since } = {}) {
    return this.ring.filter(
      (e) =>
        (!run || e.run === run) &&
        (!site || e.site === site) &&
        (!kind || e.kind === kind) &&
        (!type || e.type === type) &&
        (!since || e.seq > Number(since)),
    );
  }

  reset() {
    this.ring = [];
    try {
      writeFileSync(this.file, "");
    } catch {
      /* нет файла — не беда */
    }
  }
}

/** Control-сервер (только 127.0.0.1): GET /events?run=&site=&kind=&type=&since=, POST /reset, GET /health. */
export function startControl(journal, port, info) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && u.pathname === "/health") return json(200, { ok: true, ...info(), events: journal.ring.length });
    if (req.method === "GET" && u.pathname === "/events") return json(200, { ok: true, events: journal.query(Object.fromEntries(u.searchParams)) });
    if (req.method === "POST" && u.pathname === "/reset") {
      journal.reset();
      return json(200, { ok: true });
    }
    return json(404, { ok: false, error: "нет такого пути" });
  });
  srv.listen(port, "127.0.0.1");
  return srv;
}
