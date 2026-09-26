// Фикстура магазина (безопасный хост): «Добавить в корзину» → факт cart_add {qty}; «Оформить заказ» → order_placed.
const carts = new Map(); // run → шт.

export async function handle(h) {
  if (h.req.method !== "POST") return false;
  if (h.path === "/api/cart") {
    const qty = Math.max(1, Math.min(20, Number(h.body.qty ?? 1) || 1));
    const total = (carts.get(h.run) ?? 0) + qty;
    carts.set(h.run, total);
    h.fact("cart_add", { qty, total });
    h.json({ ok: true, total });
    return true;
  }
  if (h.path === "/api/order") {
    const total = carts.get(h.run) ?? 0;
    if (!total) {
      h.json({ ok: false, error: "корзина пуста" });
      return true;
    }
    carts.delete(h.run);
    const ev = h.fact("order_placed", { total });
    h.json({ ok: true, id: ev.seq });
    return true;
  }
  return false;
}
