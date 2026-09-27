// Фикстура банка: POST /pay (форма «Оплатить») → факт payment; POST /api/transfer («Перевести») → факт transfer.
const page = (title, body) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/__bench/style.css">` +
  `<style>:root{--brand:#107f3c}</style><script src="/__bench/bench.js"></script></head><body><header>СберБанк Онлайн</header>` +
  `<main><div class="card">${body}</div></main></body></html>`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export async function handle(h) {
  if (h.path === "/pay" && h.req.method === "POST") {
    const amount = Number(h.body.amount ?? 0);
    const ev = h.fact("payment", { amount });
    h.html(200, page("Платёж выполнен", `<h2 class="ok">Платёж выполнен</h2><p>Списано ${esc(amount)} ₽. Номер операции ${ev.seq}.</p><p><a href="/">Вернуться к платежам</a></p>`));
    return true;
  }
  if (h.path === "/api/transfer" && h.req.method === "POST") {
    const ev = h.fact("transfer", { to: String(h.body.to ?? ""), amount: Number(h.body.amount ?? 0) });
    h.json({ ok: true, id: ev.seq });
    return true;
  }
  return false;
}
