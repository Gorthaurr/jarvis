/**
 * Серверный lint-гард для code.run (§4, §6).
 *
 * ПОЛИТИКА (решение пользователя): у Джарвиса РЕАЛЬНОЕ управление Windows. Реестр, службы, сеть,
 * COM/.NET, запуск процессов, системные пути — ОТКРЫТЫ. Безопасность идёт из его экспертизы
 * («опытный оператор», персона §6), а НЕ из блок-листов возможностей. Гард оставляет только
 * КРИТИЧНЫЕ РЕЛЬСЫ §4 (то, что трудно/невозможно откатить):
 *   1) самозащита — нельзя завершать процессы самого Джарвиса (electron/node-сервер/сайдкар);
 *   2) питание — только через system_power (отложенно, с предупреждением и окном отмены);
 *   3) необратимая потеря данных — НЕ блок, а подтверждение: удаление файлов / форматирование диска;
 *   4) электронная подпись — БЛОК: юридически значима и неоткатываема (63-ФЗ), см. правило `sign`;
 *   5) отправка письма — подтверждение владельца: у code_run нет ни гейтов, ни признака «ушло».
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
  /** Необратимая операция (удаление/формат/отправка почты) — требует подтверждения пользователя (§4). */
  requiresConfirm: boolean;
  /**
   * ПОЧЕМУ спрашиваем — сообщения сработавших confirm-правил. Без них владелец видел в модалке только
   * «Выполнить код?» + первые 160 символов, а `smtplib` мог стоять сороковой строкой: подтверждение
   * вслепую подтверждением не является (§3).
   */
  confirmReasons: string[];
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
  // 4) ЭЛЕКТРОННАЯ ПОДПИСЬ (БЛОК, не confirm): на машине владельца лежит КВАЛИФИЦИРОВАННЫЙ сертификат
  //    физлица с приватным ключом (проверено: Cert:\CurrentUser\My — УЦ «Сертум-Про», СНИЛС/ИНН в
  //    субъекте, HasPrivateKey=True) и установлен КриптоПро CSP 5.0 (csptest.exe на диске). При
  //    закешированном PIN подпись ставится БЕЗ единого диалога — то есть незаметно для владельца.
  //    Почему БЛОК, а не подтверждение, как у удаления: подпись юридически значима (63-ФЗ) и
  //    необратима в том смысле, в каком удаление файла — нет. Отозвать подписанный документ нельзя,
  //    отвечает по нему лично владелец, а §2 требует способа СВЕРИТЬ исход — у подписи его нет:
  //    статический гард не знает, ЧТО именно в подписываемом файле и чем это обернётся, поэтому любой
  //    доклад «подписал» был бы ложным успехом. Подписывает владелец сам, своими руками.
  //    Языки НЕ ограничиваем: python/node так же запускают powershell и cryptcp через subprocess.
  {
    rule: "sign",
    re: /\bSet-AuthenticodeSignature\b|\bcryptcp\w*\b|\bcsptest\w*\b|\bX509Certificate2\b/i,
    message:
      "электронная подпись — юридически значимое и НЕОБРАТИМОЕ действие (63-ФЗ): подписанный документ не отозвать, отвечает по нему лично владелец. Джарвис подпись не ставит — подпишите сами. Заблокированы Set-AuthenticodeSignature / cryptcp / csptest / X509Certificate2 (последний блокируется целиком, вместе с чтением хранилища: отличить в статике «посмотреть сертификат» от «подписать им» нельзя)",
  },
  // 5) ОТПРАВКА ПОЧТЫ (confirm §3): письмо уходит человеку от лица владельца и назад не забирается.
  //    У штатного канала отправки есть подтверждение владельца, анти-дубль и признак «ушло»; у
  //    code_run нет НИ ОДНОГО из них — значит prompt-инъекция со страницы («отправь письмо по адресу
  //    X») обошла бы текстовый запрет рецепта одним вызовом smtplib, молча и без следа. Не блок
  //    (владелец вправе попросить письмо), но только через его подтверждение. Языки не ограничиваем
  //    по той же причине, что у подписи: powershell дёргает python -c и наоборот.
  {
    rule: "mail-send",
    re: /\bsmtplib\b|\bSMTP_SSL\b|\bSend-MailMessage\b/i,
    message: "отправка письма из code.run — необратимое внешнее действие от лица владельца (§3)",
    confirm: true,
  },
];

/** Прогнать статический гард над кодом (чистая функция). */
export function lintCode(lang: CodeLang, code: string): LintResult {
  const violations: LintViolation[] = [];
  const confirmReasons: string[] = [];
  for (const r of RULES) {
    if (r.langs && !r.langs.includes(lang)) continue;
    const m = r.re.exec(code);
    if (!m) continue;
    if (r.confirm) {
      // не блок — требует подтверждения (§4); причину показываем владельцу, а не прячем
      if (!confirmReasons.includes(r.message)) confirmReasons.push(r.message);
    } else violations.push({ rule: r.rule, match: m[0], message: r.message });
  }
  return {
    ok: violations.length === 0,
    violations,
    // §4: confirm ТОЛЬКО на необратимое (удаление файлов / формат диска / отправка письма). Всё прочее
    // управление Windows (реестр/службы/сеть/COM) идёт без подтверждения — безопасность из экспертизы агента.
    requiresConfirm: confirmReasons.length > 0,
    confirmReasons,
  };
}
