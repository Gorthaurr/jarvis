import type { ToolCase } from "../case-format.js";

export const cases: ToolCase[] = [
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
