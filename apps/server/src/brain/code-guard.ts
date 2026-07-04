/**
 * Серверный lint-гард для code.run (§4, §6).
 *
 * ПОЛИТИКА (решение пользователя): у Джарвиса РЕАЛЬНОЕ управление Windows. Реестр, службы, сеть,
 * COM/.NET, запуск процессов, системные пути — ОТКРЫТЫ. Безопасность идёт из его экспертизы
 * («опытный оператор», персона §6), а НЕ из блок-листов возможностей. Гард оставляет только
 * КРИТИЧНЫЕ РЕЛЬСЫ §4 (то, что трудно/невозможно откатить):
 *   1) самозащита — нельзя завершать процессы самого Джарвиса (electron/node-сервер/сайдкар);
 *   2) питание — только через system_power (отложенно, с предупреждением и окном отмены);
 *   3) необратимая потеря данных — НЕ блок, а подтверждение: удаление файлов / форматирование диска.
 * Карты/платёжные данные — красная линия §0 (проверяется отдельно, не здесь).
 *
 * Это эвристика (не песочница). Рантайм-обвязка (свежий temp-CWD, таймаут, лимит вывода,
 * усечённый env без секретов) — на клиенте (code-runner). PowerShell исполняется в FullLanguage
 * (Add-Type/COM доступны — иначе нельзя реально управлять Windows).
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
  /** Необратимая операция (удаление/формат) — требует подтверждения пользователя (§4). */
  requiresConfirm: boolean;
}

interface Rule {
  rule: string;
  re: RegExp;
  message: string;
  /** Языки, к которым правило применяется (пусто = все). */
  langs?: CodeLang[];
  /** true — не блокировать, а ПОТРЕБОВАТЬ confirm (необратимое через код, §4). */
  confirm?: boolean;
}

/** Критичные рельсы §4 (всё остальное — открыто; безопасность из экспертизы агента). */
const RULES: Rule[] = [
  // 1) САМОЗАЩИТА (блок): kill процессов самого Джарвиса = отключить ассистента. Ловим завершение
  //    ПО ИМЕНИ electron/node/sidecar (оба порядка: «taskkill … electron», «Get-Process electron | Stop-Process»).
  //    Прочие процессы (dota2, chrome, …) завершай свободно, в т.ч. по PID — это полное управление.
  {
    rule: "self-kill",
    re: /(?:taskkill|stop-process|\bkill)[\s\S]{0,80}(?:electron|sidecarwin|\bnode(?:\.exe)?\b)|(?:electron|sidecarwin|\bnode(?:\.exe)?\b)[\s\S]{0,80}(?:stop-process|taskkill)/i,
    message:
      "нельзя завершать процессы самого Джарвиса (electron/node-сервер/sidecar) — это отключит ассистента; другие процессы завершай свободно",
  },
  // 2) ПИТАНИЕ (блок): только через system_power (предупреждение + окно отмены §4), не в обход кодом.
  {
    rule: "power",
    re: /\b(?:Stop-Computer|Restart-Computer|shutdown|poweroff)\b/i,
    message: "выключение/перезагрузка — только через системный инструмент питания (он предупреждает и даёт отменить, §4)",
  },
  // 3) НЕОБРАТИМОЕ (НЕ блок, а подтверждение §4): удаление файлов / форматирование диска.
  { rule: "fs-destroy", re: /\b(?:os\.remove|os\.unlink|os\.rmdir|shutil\.rmtree)\b|\.unlink\s*\(/i, message: "удаление файлов из code.run — требует подтверждения (§4)", langs: ["python"], confirm: true },
  { rule: "fs-destroy", re: /\bfs(?:\.promises)?\.(?:unlink|rm|rmdir)(?:Sync)?\s*\(/i, message: "удаление файлов из code.run — требует подтверждения (§4)", langs: ["node"], confirm: true },
  { rule: "fs-destroy", re: /\b(?:Remove-Item|Remove-ItemProperty|Clear-Content|del|erase|rmdir|rd|ri)\b/i, message: "удаление/очистка файлов — требует подтверждения (§4)", langs: ["powershell"], confirm: true },
  { rule: "disk-destroy", re: /\b(?:Format-Volume|Format-Disk|Clear-Disk|Initialize-Disk|diskpart|Remove-Partition)\b/i, message: "форматирование/очистка диска — требует подтверждения (§4)", langs: ["powershell"], confirm: true },
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
    // §4: confirm ТОЛЬКО на необратимое (удаление файлов / формат диска). Всё прочее управление
    // Windows (реестр/службы/сеть/COM) идёт без подтверждения — безопасность из экспертизы агента.
    requiresConfirm: needsConfirm,
  };
}
