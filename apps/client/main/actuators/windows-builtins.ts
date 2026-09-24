/**
 * Встроенные программы Windows — ЗАПУСК по абсолютному пути из %SystemRoot%, а не поиском.
 *
 * Ревью 2026-09-24 (прогон резолвера): поиск по PATH/Пуску находил не то — «notepad» уходил в
 * `C:\Program Files\Git\usr\bin\notepad` (обёртка Git, если его usr\bin в PATH), «командная строка» —
 * в ярлык «Командная строка VS2015 x86 ARM Cross Tools» (cmd с vcvarsall), «панель управления» — в
 * «Панель управления Рутокен». Для встроенных программ источник истины один — системный каталог.
 *
 * Карта — по ИМЕНИ ПРОЦЕССА (то, во что `resolveAppTarget` превращает русские алиасы): алиасы остаются
 * именами процессов, потому что тот же словарь кормит фокус и закрытие (там нужен процесс, не путь).
 * Файла на диске нет (урезанная сборка Windows) → undefined, работает прежний резолвер.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** имя процесса (нижний регистр, без .exe) → путь относительно %SystemRoot% */
const BUILTIN_EXE: Record<string, string> = {
  notepad: "System32\\notepad.exe",
  calc: "System32\\calc.exe",
  mspaint: "System32\\mspaint.exe",
  taskmgr: "System32\\Taskmgr.exe",
  cmd: "System32\\cmd.exe",
  control: "System32\\control.exe",
  snippingtool: "System32\\SnippingTool.exe",
  explorer: "explorer.exe",
};

export function builtinLaunchPath(
  target: string,
  exists: (p: string) => boolean = existsSync,
  systemRoot: string = process.env.SystemRoot || process.env.windir || "C:\\Windows",
): string | undefined {
  const key = target.trim().toLowerCase().replace(/\.exe$/u, "");
  const rel = BUILTIN_EXE[key];
  if (!rel) return undefined;
  const full = join(systemRoot, rel);
  return exists(full) ? full : undefined;
}
