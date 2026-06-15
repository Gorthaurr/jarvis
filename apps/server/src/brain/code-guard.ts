/**
 * Серверный lint-гард для code.run (§6, §14).
 *
 * Полную изоляцию ФС на хосте без контейнера не сделать (§6), поэтому
 * сгенерированный код проходит статический гард НА СЕРВЕРЕ до отправки клиенту:
 * запрещены реестр, службы, сеть, абсолютные системные пути, запуск шеллов/eval.
 * powershell — ВСЕГДА требует confirm (kind:"irreversible") + Constrained Language Mode (§6).
 *
 * Это эвристика (не песочница) — слой защиты, а не гарантия; рантайм-ограничения
 * (Job Object, сетевой запрет per-process, CWD=temp) — на клиенте (code-runner).
 */
import type { CodeLang } from "@jarvis/protocol";

export interface LintViolation {
  rule: string;
  match: string;
  message: string;
}

export interface LintResult {
  ok: boolean;
  violations: LintViolation[];
  /** powershell требует подтверждения пользователя всегда (§6). */
  requiresConfirm: boolean;
}

interface Rule {
  rule: string;
  re: RegExp;
  message: string;
  /** Языки, к которым правило применяется (пусто = все). */
  langs?: CodeLang[];
  /** true — не блокировать, а ПОТРЕБОВАТЬ confirm (как powershell): необратимое через код. */
  confirm?: boolean;
}

/** Запрещённые конструкции (§6: реестр, службы, сеть, системные пути, шелл/eval). */
const RULES: Rule[] = [
  // Сеть
  { rule: "network", re: /\b(?:import\s+socket|urllib|requests|http\.client|httpx)\b/i, message: "сетевой доступ запрещён", langs: ["python"] },
  { rule: "network", re: /\b(?:require\(['"](?:net|http|https|dgram|tls)['"]\)|fetch\s*\(|axios|XMLHttpRequest|WebSocket)\b/i, message: "сетевой доступ запрещён", langs: ["node"] },
  { rule: "network", re: /\b(?:Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient|Start-BitsTransfer|curl|wget)\b/i, message: "сетевой доступ запрещён", langs: ["powershell"] },
  // Реестр
  { rule: "registry", re: /\b(?:winreg|_winreg)\b/i, message: "доступ к реестру запрещён", langs: ["python"] },
  { rule: "registry", re: /\b(?:HKEY_|HKLM:|HKCU:|New-ItemProperty|Set-ItemProperty\s+-Path\s+HK|reg\s+add|Microsoft\.Win32\.Registry)\b/i, message: "доступ к реестру запрещён" },
  // Службы
  { rule: "services", re: /\b(?:Get-Service|Stop-Service|Start-Service|Set-Service|New-Service|sc\.exe|ServiceController|win32serviceutil)\b/i, message: "управление службами запрещено" },
  // Запуск шеллов / eval / скачанный код
  { rule: "shell-exec", re: /\b(?:os\.system|subprocess\.\w+\([^)]*shell\s*=\s*True|eval\(|exec\()/i, message: "запуск шелла/eval запрещён", langs: ["python"] },
  { rule: "shell-exec", re: /(?:child_process|execSync|spawnSync|exec\s*\(|eval\s*\(|new\s+Function)/i, message: "запуск шелла/eval запрещён", langs: ["node"] },
  { rule: "shell-exec", re: /\b(?:Invoke-Expression|iex\b|Start-Process|&\s*['"])/i, message: "запуск процессов/IEX запрещён", langs: ["powershell"] },
  // Обфускация/динамический доступ (закрывает обход через аргументы самописных инструментов §8+):
  // __import__('os').system(...), os.popen, importlib, ctypes, pty, compile(...).
  { rule: "dyn-exec", re: /\b(?:__import__|importlib|ctypes|os\.popen|os\.exec\w*|pty\.spawn|subprocess|multiprocessing|compile\s*\()/i, message: "динамический импорт/исполнение запрещён (обфускация §6)", langs: ["python"] },
  { rule: "dyn-exec", re: /(?:process\.binding|globalThis\s*\[|\bimport\s*\(|Function\s*\(|require\s*\(\s*[^'"`)\s])/i, message: "динамический импорт/исполнение запрещён (обфускация §6)", langs: ["node"] },
  // Абсолютные системные пути вне CWD
  { rule: "system-path", re: /(?:C:\\\\?Windows|C:\\\\?Program Files|%SystemRoot%|\/etc\/|\/usr\/|\/bin\/|\\\\[A-Za-z0-9._-]+\\)/i, message: "абсолютные системные пути вне CWD запрещены" },
  // Деструктивные ФС-операции из code.run — НЕ блок, но через confirm (как fs_delete §4):
  // иначе python shutil.rmtree / node fs.rm стирали бы данные в обход выделенного гейта.
  { rule: "fs-destroy", re: /\b(?:os\.remove|os\.unlink|os\.rmdir|shutil\.rmtree)\b|\.unlink\s*\(/i, message: "удаление файлов из code.run — требует подтверждения (§4)", langs: ["python"], confirm: true },
  { rule: "fs-destroy", re: /\bfs(?:\.promises)?\.(?:unlink|rm|rmdir)(?:Sync)?\s*\(/i, message: "удаление файлов из code.run — требует подтверждения (§4)", langs: ["node"], confirm: true },
];

/** Прогнать статический гард над кодом (чистая функция). */
export function lintCode(lang: CodeLang, code: string): LintResult {
  const violations: LintViolation[] = [];
  let needsConfirm = false;
  for (const r of RULES) {
    if (r.langs && !r.langs.includes(lang)) continue;
    const m = r.re.exec(code);
    if (!m) continue;
    if (r.confirm) needsConfirm = true; // не блок — требует подтверждения (§4)
    else violations.push({ rule: r.rule, match: m[0], message: r.message });
  }
  return {
    ok: violations.length === 0,
    violations,
    // §6: powershell всегда confirm + CLM; деструктивные ФС-операции — тоже confirm (§4).
    requiresConfirm: lang === "powershell" || needsConfirm,
  };
}
