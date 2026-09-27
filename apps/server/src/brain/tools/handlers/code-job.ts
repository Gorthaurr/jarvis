/**
 * job_status — отчёт о ФОНОВОМ задании code_run (сценарии 2026-09-02), вынесено из code.ts (W3: место под S-9).
 * W3 (S-9): хвосты stdout/stderr задания — вывод скрипта, внутри <untrusted_content> (code-output.ts).
 */
import type { ToolContext, ToolResult } from "../dispatch.js";
import { channelDownResult, err, ok, overlayDeniedResult } from "../dispatch-util.js";
import { codeDataText, wrapCodeOutput } from "./code-output.js";

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
          `его. Сверь состояние (look{what:"elements"}/screen_capture) и продолжай по факту, вслепую не повторяй.`
        : done > 0
          ? `Успешно ушедших действий до остановки: ${done} — они НЕ откатываются; перезапуск скрипта целиком повторил бы их. Сверь состояние (look{what:"elements"}/screen_capture) и продолжай с места остановки.`
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
          `${tail}${went}${d.stdoutTail ? ` Хвост stdout:\n${wrapCodeOutput(d.stdoutTail.slice(-300))}` : ""}`,
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
          `${d.overlayReason ?? "часть действий НЕ выполнена"}. Исход НЕ ПОДТВЕРЖДЁН — сверь состояние, не повторяй вслепую. Данные: ${codeDataText(result.data, true)}`,
      );
      out.uncertain = true;
      out.jobId = jobId;
      return out;
    }
    const out = ok(result.data !== undefined ? codeDataText(result.data, true) : "ok (job.status)");
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
