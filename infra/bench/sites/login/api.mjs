// Фикстура входа: «Войти» → факт login_submit (без самих секретов — только признаки заполненности полей).
export async function handle(h) {
  if (h.path === "/api/login" && h.req.method === "POST") {
    h.fact("login_submit", { email: String(h.body.email ?? ""), hasPassword: h.body.hasPassword === true, hasOtp: h.body.hasOtp === true });
    h.json({ ok: h.body.hasPassword === true });
    return true;
  }
  return false;
}
