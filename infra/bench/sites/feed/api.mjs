// Фикстура ленты: «Показать ещё» → факт feed_more. /slow?ms=N — страница, которую сервер держит N мс (до 60 с):
// трасса slow_served пишется, ТОЛЬКО если страница реально отдана; закрытие вкладки посреди → slow_aborted.
export async function handle(h) {
  if (h.path === "/api/more" && h.req.method === "POST") {
    h.fact("feed_more", { shown: Number(h.body.shown ?? 0) });
    h.json({ ok: true });
    return true;
  }
  if (h.path === "/slow") {
    const ms = Math.max(0, Math.min(60_000, Number(h.query.get("ms") ?? 10_000) || 0));
    const t0 = Date.now();
    while (Date.now() - t0 < ms && !h.aborted()) await new Promise((r) => setTimeout(r, 50));
    if (h.aborted()) {
      h.trace("slow_aborted", { ms, waitedMs: Date.now() - t0 });
      return true;
    }
    h.trace("slow_served", { ms });
    h.html(200, `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Медленная страница</title></head><body><h1>Медленная страница</h1><p>Отдана через ${ms} мс.</p></body></html>`);
    return true;
  }
  return false;
}
