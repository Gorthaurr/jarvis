import type { ToolCase } from "../case-format.js";

const WEB = {
  "https://example.com/rates": "<html><title>Курс валют</title><body>доллар стоит девяносто рублей, евро — сто</body></html>",
};

export const cases: ToolCase[] = [
  // ───────────── §14: необратимое без «да» не выполняется, причина отказа названа честно ─────────────
  {
    tool: "fs_delete",
    name: "владелец сказал «нет» — не удалено, клиенту ничего не ушло",
    args: { path: "C:/Users/lab/Documents/report.txt" },
    confirm: "no",
    expect: { ok: true, flags: { declined: true }, asked: 1, actionKinds: [], resultIncludes: /отменено пользователем/i },
    coversTool: "fs_delete",
  },
  {
    tool: "fs_delete",
    name: "владельца не смогли спросить — не приписываем ему отказ",
    args: { path: "C:/Users/lab/Documents/report.txt" },
    confirm: "undelivered",
    expect: { flags: { declined: true }, asked: 1, actionKinds: [], resultIncludes: /не смог спросить|недоступн/i, resultExcludes: /отменено пользователем/i },
    coversTool: "fs_delete",
  },
  {
    tool: "system_power",
    name: "выключение без ответа владельца (окно истекло) — не выключаем",
    args: { op: "shutdown" },
    confirm: "expire",
    expect: { flags: { declined: true }, asked: 1, actionKinds: [], resultIncludes: /не ответили|истекл/i },
    coversTool: "system_power",
  },
  // ───────────── Честные отказы серверных гейтов ─────────────
  {
    tool: "look",
    name: "неизвестный вид взгляда — «неизвестный инструмент», а не молчаливый успех",
    args: { what: "bogus" },
    expect: { ok: false, actionKinds: [], resultIncludes: "Неизвестный инструмент" },
    coversTool: "look",
  },
  {
    tool: "web_open",
    name: "имя указывает во внутреннюю сеть (DNS) — SSRF-гард, до клиента не доходит",
    args: { url: "http://localtest.me/panel" },
    expect: { ok: false, actionKinds: [], resultIncludes: /SSRF|внутрен/ },
    coversTool: "web_open",
  },
  {
    tool: "browser_read",
    name: "нужен Chrome+расширение — честно «не проверяется в лаборатории»",
    args: {},
    expect: { ok: false, notVerifiable: /расширени/, actionKinds: [] },
    coversTool: "browser_read",
  },
  // ───────────── Серверные сервисы на изолированных сторах ─────────────
  {
    tool: "web_search",
    name: "поиск идёт по страницам из seed.web, а не в сеть",
    args: { query: "доллар курс" },
    seed: { web: WEB },
    expect: { ok: true, resultIncludes: ["https://example.com/rates", "Курс валют"], actionKinds: [] },
    coversTool: "web_search",
  },
  {
    tool: "list_reminders",
    name: "поставленное напоминание видно в списке",
    args: {},
    before: [{ tool: "set_reminder", args: { text: "Позвонить маме, сэр", delay_seconds: 3600 } }],
    expect: { ok: true, resultIncludes: "Позвонить маме", actionKinds: [] },
    coversTool: "list_reminders",
  },
  {
    tool: "memory_search",
    name: "записанный факт находится семантическим поиском (память не dev-пропуск)",
    args: { query: "любимый цвет" },
    before: [{ tool: "memory_write", args: { text: "Любимый цвет владельца — зелёный", kind: "preference" } }],
    expect: { ok: true, resultIncludes: "зелёный", actionKinds: [] },
    coversTool: "memory_search",
  },
];
