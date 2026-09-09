/**
 * Хендлеры ИСПОЛНЕНИЯ КОДА (§6) — вынесено из god-object dispatch.ts (§ревью).
 * code_run под серверным lint-гардом + единый `executeGuardedCode` (lint → confirm на необратимое → code.run).
 * `executeGuardedCode` переиспользует и самописный инструмент (runDynamicTool в dispatch) — гард не обойти.
 */
import { type CodeLang } from "@jarvis/protocol";
import { lintCode } from "../../code-guard.js";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { channelDownResult, confirmDeclineText, declined, gateDeclined, err, ok, overlayDeniedResult } from "../dispatch-util.js";

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
  return executeGuardedCode(ctx, lang, code, opts);
}

/**
 * Контроль-7 (sdk-2): job_status ФОНОВОГО задания, легшего об вуаль (клиент: overlayStopped/overlayDone), — тот же
 * структурный признак, что у синхронного code_run: overlayDenied + overlayStepIndex (сделанное до остановки едет в
 * терминал и журнал), иначе «code_run(background) — ok» и «повтори скрипт целиком» = дубль кликов.
 */
export async function jobStatusTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const jobId = String(input.jobId ?? "").trim();
  if (!jobId) return err("job_status: нужен jobId");
  const result = await ctx.session.sendAction({ kind: "job.status", jobId, ...(input.kill === true || input.kill === "true" ? { kill: true } : {}) }, 20_000);
  if (result.ok) {
    const d = (result.data ?? {}) as {
      running?: boolean;
      exitCode?: number;
      overlayStopped?: boolean;
      overlayReason?: string;
      overlayDone?: number;
      overlayInjected?: boolean;
      overlayCaught?: boolean;
      stdoutTail?: string;
      killed?: boolean;
    };
    if (d.overlayStopped === true) {
      const done = typeof d.overlayDone === "number" && d.overlayDone > 0 ? d.overlayDone : 0;
      // Контроль-8 (job-veil-done0-text): при done=0 повторять нечего — «перезапуск повторил бы их» и «продолжай с
      // места остановки» отговаривали модель от законного перезапуска и слали искать несуществующую точку.
      // Контроль-9 (job-veil-done0-injected-contradiction): состояний ТРИ, а ветвление шло по одному `done`. При
      // `done=0 && injected` (типовой случай: вуаль поймала САМОЕ ПЕРВОЕ действие скрипта в момент инжекции) текст
      // одновременно утверждал «уйти ничего не успело, запускай ЦЕЛИКОМ» и «действие УЖЕ УШЛО» — первая половина
      // прямо санкционировала дубль необратимого действия в GUI.
      const injected = d.overlayInjected === true;
      const tail = injected
        ? `${done > 0 ? `Успешно ушедших действий до остановки: ${done} — они НЕ откатываются. ` : ""}` +
          `Действие последнего шага УЖЕ УШЛО в GUI, его ИСХОД НЕ ПОДТВЕРЖДЁН: перезапуск скрипта ЦЕЛИКОМ повторил бы ` +
          `его. Сверь состояние (ui_snapshot/screen_capture) и продолжай по факту, вслепую не повторяй.`
        : done > 0
          ? `Успешно ушедших действий до остановки: ${done} — они НЕ откатываются; перезапуск скрипта целиком повторил бы их. Сверь состояние (ui_snapshot/screen_capture) и продолжай с места остановки.`
          : `Ни одно действие уйти не успело: после закрытия оверлея скрипт можно запустить заново ЦЕЛИКОМ.`;
      const went = "";
      const out = overlayDeniedResult(
        {
          ok: false,
          error: { code: "overlay_drawing", message: "" },
          ...(done > 0 ? { stepIndex: done } : {}),
          ...(d.overlayInjected === true ? { stepActionInjected: true } : {}),
        },
        `Фоновое задание ${jobId} ОСТАНОВЛЕНО вуалью режима выделения: ${d.overlayReason ?? "поверх экрана вуаль"}. ` +
          `${tail}${went}${d.stdoutTail ? ` Хвост stdout: ${d.stdoutTail.slice(-300)}` : ""}`,
      ) as ToolResult;
      out.jobId = jobId;
      // Контроль-9 (job-veil-done0-not-failure): «процедуру остановила вуаль» — структурный факт, не производная от
      // числа сделанных шагов. Без него отчёт с done=0 не давал петле НИ ОДНОГО признака, и ход, в котором не
      // сделано ничего, заканчивался `done`/`ok:true`.
      out.overlayProcedure = true;
      return out;
    }
    // Контроль-8 (background-caught-exit0): скрипт ПЕРЕХВАТИЛ отказ вуали (голый except ловит SystemExit) и вышел
    // кодом 0 — зеркало синхронного пути; чистый «exitCode: 0» читался бы успехом при невыполненных действиях.
    if (d.overlayCaught === true) {
      const out = ok(
        `⚠️ Фоновое задание ${jobId} ПЕРЕХВАТИЛО отказ вуали режима выделения и продолжило, будто действие прошло: ` +
          `${d.overlayReason ?? "часть действий НЕ выполнена"}. Исход НЕ ПОДТВЕРЖДЁН — сверь состояние, не повторяй вслепую. Данные: ${JSON.stringify(result.data)}`,
      );
      out.uncertain = true;
      out.jobId = jobId;
      return out;
    }
    const out = ok(result.data !== undefined ? JSON.stringify(result.data) : "ok (job.status)");
    out.jobId = jobId;
    // Контроль-8 (background-job-no-success): неопределённость запуска РЕЗОЛВИТСЯ фактом завершения. Без этого
    // успешно собранный проект получал «Не вышло, сэр — нужное действие не сработало» (masked-failure), ok:false в
    // метриках и минус исправному навыку; а честное «задание ещё выполняется» ловилось анти-капитуляцией как отказ.
    // Контроль-9 (job-kill-neutral-masked-failure): «останови сборку» — job_status{kill:true} РЕАЛЬНО бьёт дерево
    // процессов, но клиент возвращается ДО события close (`running:true`), а сам инструмент нейтрален: ход
    // заканчивался подменой «Готово, сэр.» на «Не вышло, сэр — нужное действие не сработало» при убитой сборке.
    // Судим по авторитетному факту клиента (`killed`) либо по тому, что задание уже не идёт.
    // Контроль-10 (kill-label-over-done): просьба убить НЕ переписывает факт успешного завершения — задание,
    // успевшее собраться с кодом 0, обязано резолвить неопределённость запуска (иначе журнал навсегда оставлял
    // «ИСХОД НЕИЗВЕСТЕН», а «доделай» пересобирало проект заново).
    const killAsked = input.kill === true || input.kill === "true";
    if (killAsked && d.killed === true) out.backgroundJob = "killed";
    else if (d.running === false && d.exitCode === 0) out.backgroundJob = "done";
    else if (killAsked && d.running === false) out.backgroundJob = "killed";
    else if (d.running === true) out.backgroundJob = "running";
    return out;
  }
  const cd = channelDownResult(result, "job_status не отправлен: канал с ПК недоступен (переподключение).");
  if (cd) return cd;
  return err(`job_status не удалось: ${result.error?.code ?? "runtime"} ${result.error?.message ?? ""}`);
}

/** Параметры запуска (сценарии 2026-09-02, причина №2): каталог репозитория, окно запуска, фоновое задание. */
export interface CodeRunOpts {
  cwd?: string;
  timeoutMs?: number;
  background?: boolean;
}

/**
 * Единый гардированный путь исполнения кода (§6): lint → (powershell/необратимое: confirm) → code.run.
 * Используется и code_run, и самописными инструментами — самописный не обходит предохранители.
 */
export async function executeGuardedCode(ctx: ToolContext, lang: CodeLang, code: string, opts: CodeRunOpts = {}): Promise<ToolResult> {
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
        `Фоновое задание ЗАПУЩЕНО: ${result.data !== undefined ? JSON.stringify(result.data) : "ok"}. ИСХОД ЕЩЁ НЕ ИЗВЕСТЕН — не говори «готово»: ` +
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
          `${caught.overlayReason ?? "часть действий НЕ выполнена"}. Исход скрипта НЕ ПОДТВЕРЖДЁН — сверь состояние (ui_snapshot/screen_capture), ` +
          `не повторяй вслепую. Данные: ${JSON.stringify(result.data)}`,
      );
      out.uncertain = true;
      return out;
    }
    return ok(result.data !== undefined ? JSON.stringify(result.data) : "ok (code.run)");
  }
  const cd = channelDownResult(result, "code.run не отправлен: канал с ПК недоступен (переподключение)."); // Б4 #4
  if (cd) return cd;
  // Контроль-6 (V5-2): скрипт SDK лёг об вуаль — клиент шлёт код overlay_drawing (+stepIndex = сделанные действия), а
  // сервер до сих пор читал его обычным `code.run не удалось` → провал модели для петли (эскалация), «не выполнено» в
  // терминале про уже сделанные клики. Тот же хелпер, что у generic-пути/навыков/берста.
  const od = overlayDeniedResult(result, `code.run ${result.error?.message ?? "остановлен вуалью режима выделения"}`);
  if (od) return od;
  return err(`code.run не удалось: ${result.error?.code ?? "runtime"} ${result.error?.message ?? ""}`);
}
