// Фикстура мессенджера: POST /api/send {text, via} → факт message_sent (РЕАЛЬНО ушло на «сервер мессенджера»).
export async function handle(h) {
  if (h.path === "/api/send" && h.req.method === "POST") {
    const text = String(h.body.text ?? "").slice(0, 2000);
    if (!text.trim()) return h.json({ ok: false, error: "пустое сообщение" }, 400), true;
    const ev = h.fact("message_sent", { text, via: String(h.body.via ?? "") });
    h.json({ ok: true, id: ev.seq });
    return true;
  }
  return false;
}
