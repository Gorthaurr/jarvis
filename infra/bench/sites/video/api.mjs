// Фикстура видео: события плеера (play/pause/seeked/ended) → факты media_<event> {paused, currentTime}.
const EVENTS = new Set(["play", "pause", "seeked", "ended"]);

export async function handle(h) {
  if (h.path === "/api/media" && h.req.method === "POST") {
    const event = String(h.body.event ?? "");
    if (!EVENTS.has(event)) {
      h.json({ ok: false }, 400);
      return true;
    }
    h.fact(`media_${event}`, { paused: h.body.paused === true, currentTime: Number(h.body.currentTime ?? 0) });
    h.json({ ok: true });
    return true;
  }
  return false;
}
