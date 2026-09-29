/**
 * ОБРАЗЦОВЫЕ кейсы инструментов — эталон для тех, кто допишет кейсы по всем ~112 схемам (README.md рядом).
 * Порядок: сначала серверные (живут без FakeDesktop), затем зависящие от «ПК» — они сами оживают, когда FakeDesktop
 * научится нужному виду команд (раннер пропускает их с причиной, а не рисует зелёное).
 *
 * Правила эталона: (1) проверять ФАКТ — флаги честности, вопросы §14, ушедшие команды, эффекты и состояние «ПК»,
 * а не «ok:true»; (2) отказ/недоступность — тоже кейс: «не выполнено» обязано быть видно и в `actionKinds: []`;
 * (3) `coversTool` — канонический инструмент (за фасадом look/window/audio — его настоящее имя).
 */
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

  // ───────────── Зависят от FakeDesktop: команда → эффект → состояние «ПК» ─────────────
  {
    tool: "fs_write",
    name: "файл записан: эффект fs.write и содержимое в виртуальной ФС",
    args: { path: "C:/Users/lab/Documents/note.txt", content: "купить хлеб" },
    expect: {
      ok: true,
      actionKinds: ["fs.write"],
      effects: [{ has: "fs.write", detail: { path: "C:/Users/lab/Documents/note.txt" } }],
      state: (s) => s.files["C:/Users/lab/Documents/note.txt"] === "купить хлеб" || `в ФС: ${JSON.stringify(s.files["C:/Users/lab/Documents/note.txt"])}`,
    },
    coversTool: "fs_write",
  },
  {
    tool: "fs_delete",
    name: "владелец сказал «да» — файл реально удалён и это видно по эффекту",
    args: { path: "C:/Users/lab/Documents/note.txt" },
    before: [{ tool: "fs_write", args: { path: "C:/Users/lab/Documents/note.txt", content: "x" } }],
    confirm: "yes",
    expect: {
      ok: true,
      flags: { declined: false },
      asked: 1,
      actionKinds: ["fs.delete"],
      effects: [{ has: "fs.delete" }],
      state: (s) => !("C:/Users/lab/Documents/note.txt" in s.files) || "файл остался в ФС",
    },
    coversTool: "fs_delete",
  },
  {
    tool: "system_volume",
    name: "громкость выставлена: состояние «ПК» = запрошенному уровню",
    args: { op: "set", level: 30 },
    expect: { ok: true, actionKinds: ["system.volume"], state: (s) => s.volume === 30 || `громкость ${s.volume}` },
    coversTool: "system_volume",
  },
  {
    tool: "system_clipboard",
    name: "запись в буфер обмена доходит до буфера «ПК»",
    args: { op: "write", text: "секретная фраза" },
    expect: { ok: true, actionKinds: ["system.clipboard"], state: (s) => s.clipboard === "секретная фраза" || `буфер: ${JSON.stringify(s.clipboard)}` },
    coversTool: "system_clipboard",
  },
  {
    tool: "app_launch",
    name: "блокнот запущен: появился процесс и эффект app.launch",
    args: { app: "notepad" },
    expect: {
      ok: true,
      actionKinds: ["app.launch"],
      effects: [{ has: "app.launch" }],
      state: (s) => Object.keys(s.processes).some((p) => /notepad/i.test(p)) || `процессы: ${Object.keys(s.processes).join(", ")}`,
    },
    coversTool: "app_launch",
  },
  {
    tool: "fs_append",
    name: "дописано в конец, а не поверх: старое содержимое цело",
    args: { path: "C:/Users/lab/Documents/log.txt", content: "вторая строка" },
    seed: { files: { "C:/Users/lab/Documents/log.txt": "первая строка\n" } },
    expect: {
      ok: true,
      actionKinds: ["fs.append"],
      state: (s) => {
        const t = s.files["C:/Users/lab/Documents/log.txt"];
        return (typeof t === "string" && t.startsWith("первая строка") && t.endsWith("вторая строка")) || `в ФС: ${JSON.stringify(t)}`;
      },
    },
    coversTool: "fs_append",
  },
  {
    tool: "fs_list",
    name: "листинг каталога показывает файлы из seed",
    args: { path: "C:/Users/lab/Documents" },
    seed: { files: { "C:/Users/lab/Documents/a.txt": "1", "C:/Users/lab/Documents/b.txt": "2" } },
    expect: { ok: true, actionKinds: ["fs.list"], resultIncludes: ["a.txt", "b.txt"], effects: [{ none: "fs.write" }] },
    coversTool: "fs_list",
  },
  {
    tool: "window",
    name: "focus по заголовку: окно стало передним (фасад → window_focus, честный readback)",
    args: { op: "focus", query: "Отчёт" },
    seed: { windows: [{ title: "Отчёт — Word", process: "winword" }, { title: "Музыка", process: "spotify" }] },
    expect: {
      ok: true,
      actionKinds: ["window.focus"],
      state: (s) => s.windows.find((w) => w.hwnd === s.foregroundHwnd)?.title === "Отчёт — Word" || `передний hwnd=${s.foregroundHwnd}`,
    },
    coversTool: "window_focus",
  },
  {
    tool: "window",
    name: "focus окна, которого нет, — ошибка, а не «сфокусировано»",
    args: { op: "focus", query: "НетТакогоОкна" },
    expect: { ok: false, resultExcludes: /сфокусировано|focused":\s*true/i },
    coversTool: "window_focus",
  },
  {
    tool: "look",
    name: "look{windows} видит окна рабочего стола из seed (фасад → window.list)",
    args: { what: "windows" },
    seed: { windows: [{ title: "Отчёт — Word", process: "winword" }, { title: "Музыка", process: "spotify" }] },
    expect: { ok: true, actionKinds: ["window.list"], resultIncludes: ["Отчёт — Word", "Музыка"] },
    coversTool: "window_list",
  },
];
