/**
 * Хендлеры ИСПОЛНЕНИЯ КОДА (§6) — вынесено из god-object dispatch.ts (§ревью).
 * code_run под серверным lint-гардом + единый `executeGuardedCode` (lint → confirm на необратимое → code.run).
 * `executeGuardedCode` переиспользует и самописный инструмент (runDynamicTool в dispatch) — гард не обойти.
 * W3: вывод скрипта — в <untrusted_content> (S-9, code-output.ts); SDK-скрипт (`import jarvis`) — руки в GUI:
 * фоном не запускается (G-14), упавший посреди кликов — исход неизвестен (L-2). job_status — code-job.ts.
 */
import { type CodeLang } from "@jarvis/protocol";
import { lintCode } from "../../code-guard.js";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { channelDownResult, confirmDeclineText, gateDeclined, err, ok, overlayDeniedResult } from "../dispatch-util.js";
import { codeDrivesInput } from "../code-input.js";
import { codeDataText, codeMessageText } from "./code-output.js";
export { jobStatusTool } from "./code-job.js";

/** G-14: фоновое задание переживает задачу и её аренду ввода — клики SDK пошли бы наперегонки с другими задачами. */
const SDK_BACKGROUND_REFUSED =
  "code_run: скрипт с `import jarvis` (клики/печать через мост) фоном НЕ запускается — фоновое задание живёт дольше задачи " +
  "и её аренды ввода, его клики шли бы наперегонки с другими задачами. Ничего не запущено. Запусти синхронно (без " +
  "background; долгий — с timeoutMs до 180000) и после скрипта сверь исход (look).";
/** L-2: SDK-скрипт упал посреди работы — часть кликов/ввода могла уйти. */
const SDK_PARTIAL_NOTE =
  "\nСкрипт с jarvis мог успеть часть кликов/ввода до сбоя — исход НЕ ПОДТВЕРЖДЁН: сверь состояние (look{what:'elements'}), целиком вслепую не повторяй.";

/** code.run под серверным lint-гардом (§6): запрет реестра/служб/сети/системных путей. */
export async function runCodeGuarded(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const lang = input.lang as CodeLang;
  const code = String(input.code ?? "");
  if (!["python", "node", "powershell"].includes(lang)) return err("code_run: неизвестный lang");
  if (!code.trim()) return err("code_run: пустой код");
  const opts: CodeRunOpts = {};
  const cwd = String(input.cwd ?? "").trim();
  if (cwd) opts.cwd = cwd;
  if (input.timeoutMs !== undefined && input.timeoutMs !== null && input.timeoutMs !== "") {
    const t = Number(input.timeoutMs);
    if (!Number.isFinite(t) || t < 1000) return err(`code_run: timeoutMs должен быть числом ≥1000 (мс), получено ${JSON.stringify(input.timeoutMs)}`);
    opts.timeoutMs = Math.min(180_000, Math.round(t));
  }
  if (input.background === true || input.background === "true") opts.background = true;
  if (opts.background && codeDrivesInput(lang, code)) return err(SDK_BACKGROUND_REFUSED); // до lint/confirm/sendAction
  return executeGuardedCode(ctx, lang, code, { ...opts, untrustedOutput: true });
}

/** Параметры запуска (сценарии 2026-09-02, причина №2): каталог репозитория, окно запуска, фоновое задание. */
export interface CodeRunOpts {
  cwd?: string;
  timeoutMs?: number;
  background?: boolean;
  /** S-9: вывод скрипта — в <untrusted_content> (code_run, самописный). Проба app_channel_learn читает СЫРОЙ JSON. */
  untrustedOutput?: boolean;
}

/**
 * Единый гардированный путь исполнения кода (§6): lint → (powershell/необратимое: confirm) → code.run.
 * Используется и code_run, и самописными инструментами — самописный не обходит предохранители.
 */
export async function executeGuardedCode(ctx: ToolContext, lang: CodeLang, code: string, opts: CodeRunOpts = {}): Promise<ToolResult> {
  const wrap = opts.untrustedOutput === true;
  const lint = lintCode(lang, code);
  if (!lint.ok) {
    return err(`код отклонён гардом (§6): ${lint.violations.map((v) => v.message).join("; ")}`);
  }
  if (lint.requiresConfirm) {
    // §4: подтверждаем ТОЛЬКО необратимое (удаление файлов / форматирование диска). Всё прочее
    // управление Windows (реестр/службы/сеть/COM) идёт без модалки — автономия по решению пользователя.
    if (!ctx.confirm) return err("необратимая операция требует подтверждения (§4), но канал недоступен.");
    // Причина ПЕРЕД кодом: отправка письма (smtplib/Send-MailMessage) может стоять сороковой строкой,
    // а в модалку влезают лишь первые 160 символов — без причины владелец подтверждал бы вслепую (§3).
    const why = lint.confirmReasons.length > 0 ? `${lint.confirmReasons.join("; ")}\n\n` : "";
    const gate = await ctx.confirm(`Выполнить код?\n${why}${code.slice(0, 160)}${code.length > 160 ? "…" : ""}`, "irreversible");
    if (!gate.approved) return gateDeclined(confirmDeclineText(gate.outcome, "code.run"), gate.outcome);
  }
  // Таймаут с запасом над окном раннера (явный timeoutMs или макс. 180с): раннер сам убьёт зависший процесс
  // по своему wall-clock. Фоновое задание отвечает сразу (spawn) — короткое окно.
  const actionTimeout = opts.background ? 20_000 : (opts.timeoutMs ?? 180_000) + 5_000;
  const result = await ctx.session.sendAction(
    { kind: "code.run", lang, code, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.background ? { background: true } : {}) },
    actionTimeout,
  );
  if (result.ok) {
    if (opts.background) {
      const out = ok(
        `Фоновое задание ЗАПУЩЕНО: ${result.data !== undefined ? codeDataText(result.data, wrap) : "ok"}. ИСХОД ЕЩЁ НЕ ИЗВЕСТЕН — не говори «готово»: ` +
          `опрашивай job_status{jobId} (running:false + exitCode) или жди wait_for{kind:"process", pid, gone:true} / wait_for{kind:"file", path, stableMs}; результат сверяй по файлу/выводу.`,
      );
      // Контроль-8 (background-string-flag): признак «исход неизвестен» ставится ТАМ, ГДЕ ФЛАГ УЖЕ НОРМАЛИЗОВАН.
      // Петля выводила его из СЫРОГО input.background === true и не видела формы `background:"true"`, которую сам
      // хендлер принимает: голый spawn засчитывался «делом сделанным», и «Готово» на не начавшемся прогоне
      // проходило успехом. Отсюда же журнал получает «ИСХОД НЕИЗВЕСТЕН — сверь», а не «ok».
      out.uncertain = true;
      out.jobLaunched = true; // контроль-10: «запуск» отличается от «отчёта о запуске»
      const jid = (result.data as { jobId?: unknown } | undefined)?.jobId;
      if (typeof jid === "string" && jid) out.jobId = jid; // связь ЗАПУСК ↔ СТАТУС: подтверждённый исход снимает неопределённость
      return out;
    }
    // Контроль-7 (sdk-3): скрипт ПЕРЕХВАТИЛ отказ вуали (голый except/BaseException) и вышел кодом 0 — «ok» был бы ложным
    // успехом при известном клиенту отказе; исход помечаем НЕИЗВЕСТНЫМ (uncertain: петля не считает дело сделанным,
    // журнал не пишет «ok»).
    const caught = result.data as { overlayCaught?: boolean; overlayReason?: string } | undefined;
    if (caught?.overlayCaught === true) {
      const out = ok(
        `⚠️ Скрипт ПЕРЕХВАТИЛ отказ вуали режима выделения (except без типа/BaseException) и продолжил, будто действие прошло: ` +
          `${caught.overlayReason ?? "часть действий НЕ выполнена"}. Исход скрипта НЕ ПОДТВЕРЖДЁН — сверь состояние (look{what:"elements"}/screen_capture), ` +
          `не повторяй вслепую. Данные: ${codeDataText(result.data, wrap)}`,
      );
      out.uncertain = true;
      return out;
    }
    return ok(result.data !== undefined ? codeDataText(result.data, wrap) : "ok (code.run)");
  }
  const cd = channelDownResult(result, "code.run не отправлен: канал с ПК недоступен (переподключение)."); // Б4 #4
  if (cd) return cd;
  // Контроль-6 (V5-2): скрипт SDK лёг об вуаль — клиент шлёт код overlay_drawing (+stepIndex = сделанные действия), а
  // сервер до сих пор читал его обычным `code.run не удалось` → провал модели для петли (эскалация), «не выполнено» в
  // терминале про уже сделанные клики. Тот же хелпер, что у generic-пути/навыков/берста.
  const od = overlayDeniedResult(result, `code.run ${codeMessageText(result.error?.message ?? "остановлен вуалью режима выделения", wrap)}`);
  if (od) return od;
  const out = err(`code.run не удалось: ${result.error?.code ?? "runtime"} ${codeMessageText(result.error?.message ?? "", wrap)}`);
  // L-2: SDK-скрипт ушёл в раннер и упал (исключение/таймаут) — сделанные до сбоя клики не откатываются: исход неизвестен
  // (петля взводит долг сверки, журнал пишет «СВЕРЬ перед повтором»). До отправки (lint/confirm/канал) — не сюда.
  if (codeDrivesInput(lang, code)) Object.assign(out, { content: `${String(out.content)}${SDK_PARTIAL_NOTE}`, uncertain: true });
  return out;
}
