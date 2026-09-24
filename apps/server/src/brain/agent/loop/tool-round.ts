// W3 «Петля»: раунд инструментов: аренда, диспатч, результат, классификация каждого вызова, закрытие раунда.
import { log, notifyToolRound, PARALLEL_READONLY_TOOLS } from "./util.js";
import type { LoopCtx } from "./context.js";
import { dispatchTool } from "../../tools/dispatch.js";
import { noteToolCall, applySuccessEffects, applyRoundFlags } from "./tool-classify.js";
import { toolNeedsInput } from "../../tools/input-kinds.js";
import type { LlmContentBlock, LlmResponse } from "../../../integrations/llm.js";
import { isBlindMutate } from "../error-voice.js";
import { canonicalToolCall, canonicalToolName } from "@jarvis/tools";

/**
 * B-F6: tool_result вызова, снятого отменой владельца (не «ошибка инструмента»). Последовательный вызов не исполнялся
 * вовсе; параллельное ЧТЕНИЕ могло успеть уйти (allowlist без побочных эффектов) — его результат отброшен.
 */
export const CANCELLED_RESULT = "Отменено владельцем — вызов не исполнен (или его результат чтения отброшен), ничего не изменено.";

/** Факты одного раунда инструментов — прежние локальные переменные цикла, теперь один объект для фаз. */
export interface RoundResult {
  resultBlocks: LlmContentBlock[];
  sawVerifyThisRound: boolean; // §адаптация к цели: был ли в раунде успешный verify-инструмент
  roundChannelDown: boolean; // Б4 (г/д): хоть одна команда не ушла — канал ПК временно мёртв
  roundOverlayDenied: boolean; // §режим выделения: ввод не инжектировался из-за вуали — состояние системы, не провал модели
  overlayDeniedIds: Set<string>; // контроль-3: такие вызовы не считаются «топтанием» в семейном anti-runaway
  roundErrors: number; // контроль-4: сколько результатов раунда — ошибки (вуаль засчитывается только если ВСЕ ошибки — вуаль)
  roundVeiled: boolean; // контроль-4: в раунде был сенсор/кадр ПОД ВУАЛЬЮ — вуаль ещё стоит
  veiledIds: Set<string>; // контроль-5 (V4-4): опрос под вуалью — ожидание, не «топтание» и не флуд
  backgroundRunningIds: Set<string>; // контроль-9: опрос ИДУЩЕГО фонового задания — ожидание процесса
  backgroundWaitRound: boolean; // контроль-10: ВЕСЬ раунд — опросы идущего фонового задания (считается при закрытии раунда)
}

export function newRound(): RoundResult {
  return {
    resultBlocks: [],
    sawVerifyThisRound: false,
    roundChannelDown: false,
    roundOverlayDenied: false,
    overlayDeniedIds: new Set<string>(),
    roundErrors: 0,
    roundVeiled: false,
    veiledIds: new Set<string>(),
    backgroundRunningIds: new Set<string>(),
    backgroundWaitRound: false,
  };
}

export function pushAssistantTurn(ctx: LoopCtx, resp: LlmResponse): void {
  const { deps, text, opts, st, convo } = ctx;
  // Реплеим ход ассистента (текст + tool_use) и результаты инструментов.
  const assistantBlocks: LlmContentBlock[] = [];
  // extended thinking + tool-use: thinking-блоки ОБЯЗАНЫ идти ПЕРВЫМИ в assistant-ходе (иначе API 400).
  if (resp.thinkingBlocks?.length) assistantBlocks.push(...resp.thinkingBlocks);
  if (resp.text) assistantBlocks.push({ type: "text", text: resp.text });
  for (const tu of resp.toolUses) {
    assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
  }
  // Разговорный ход ушёл в ИНСТРУМЕНТЫ → он уже не «мгновенный ответ», а работа: занимаем слот,
  // чтобы потолок параллельности видел правду. Не вышло — просто идём дальше (никого не ждём).
  if (opts?.conversational && !st.progress.convoSlotHeld && resp.toolUses.length > 0 && deps.concurrency?.tryAcquire()) {
    st.progress.convoSlotHeld = true;
  }
  convo.push({ role: "assistant", content: assistantBlocks });
}

/**
 * W4 фасады: look/window/audio → канонический инструмент для аренды, диспатча, классификации и метки чипа.
 * ВСЕГДА новый объект (id тот же): `tu` кладёт SDK, и по нему канал подписки сопоставляет хендлер с результатом
 * (subscription-session: имя + канонический JSON аргументов) — мутация in-place подвесила бы хендлер.
 */
export function canonicalUse(tu: LlmResponse["toolUses"][number]): LlmResponse["toolUses"][number] {
  const c = canonicalToolCall(tu.name, tu.input);
  return { ...tu, name: c.name, input: c.input };
}

export function prefetchReadonly(ctx: LoopCtx, resp: LlmResponse) {
  const { toolCtx, task } = ctx;
  // B-F6: отменили, пока модель думала, — не запускаем даже чтения (раунд закроется честными «отменено»).
  if (task.cancel.cancelled) return null;
  // §Волна2 (2.2): раунд целиком из ЯВНО READ-ONLY вызовов → диспатчим ПАРАЛЛЕЛЬНО: wall-clock =
  // max, не сумма (research-раунды в 2-3× быстрее). Любой прочий вызов в раунде → строго
  // последовательный путь как раньше (порядок побочных эффектов свят — fs_write→fs_read не
  // переставляем; «нейтральные» с durable-записью — memory_write/skill_save/set_reminder —
  // в allowlist НЕ входят, ревью: write→read гонка внутри раунда).
  // Реджекты конвертируются в значения (нет unhandled rejection при раннем break по отмене) и
  // перебрасываются в точке потребления — семантика ошибок 1:1 с последовательным путём.
  const parallelSafe =
    resp.toolUses.length > 1 &&
    resp.toolUses.every((tu) => PARALLEL_READONLY_TOOLS.has(canonicalToolName(tu.name, tu.input)));
  const prefetched = parallelSafe
    ? new Map(
        resp.toolUses.map((tu) => [
          tu.id,
          dispatchTool(canonicalUse(tu).name, canonicalUse(tu).input, toolCtx).then(
            (r) => ({ ok: true as const, r }),
            (e: unknown) => ({ ok: false as const, e }),
          ),
        ]),
      )
    : null;
  if (parallelSafe) log.debug("§Волна2: параллельный не-GUI раунд", { tools: resp.toolUses.map((t) => t.name) });
  return prefetched;
}

export async function acquireForTool(ctx: LoopCtx, tu: LlmResponse["toolUses"][number], round: RoundResult): Promise<"break" | "continue" | "ok"> {
  const { st, task, ensureInput } = ctx;
  const { INPUT_WAIT_MS, STALE_INPUT_WAIT_MS } = ctx.cfg;
  // GUI-команда (клик/печать/фокус/окно/скилл) → берём аренду ввода ДО исполнения,
  // чтобы не столкнуться с параллельной задачей за курсор (§20). Держим до конца задачи.
  if (toolNeedsInput(tu.name)) {
    const got = await ensureInput();
    // Отменили, пока ждали аренду — НЕ шлём GUI-команду (аренду ensureInput уже отдал).
    if (task.cancel.cancelled) return "break";
    if (!got) {
      // Волна 1: аренда не освободилась за таймаут → ЧЕСТНАЯ ошибка инструмента, решает модель
      // (работать без физического ввода / завершить с честным статусом), а не вечное зависание.
      st.progress.toolTrajectory.push(`${tu.name} (ошибка)`); // сам признак inputDenied ставит ensureInput
      round.resultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content:
          `Мышь/клавиатура заняты ДРУГОЙ ЗАДАЧЕЙ Джарвиса — аренда ввода не освободилась за ` +
          `${Math.round(INPUT_WAIT_MS / 1000)}с. Это внутренняя очередь, ВЛАДЕЛЕЦ тут ни при чём: ` +
          `не объясняй провал тем, что он «за компьютером» — система по этой причине твои ` +
          `действия не отклоняет. Сделай, что можно БЕЗ физического ввода (web/код/чтение), ` +
          `или заверши с честным статусом «ввод занят другой задачей».`,
        is_error: true,
      });
      return "continue";
    }
    // Волна 1, гард протухшего клика: аренду ждали долго → экран мог измениться за это время
    // (живой случай: клик выстрелил после 236с очереди по давно ушедшему состоянию). Слепые
    // действия блокируются, пока модель не сверится глазами (verify снимает гард), но не больше
    // 2 блоков (анти-deadloop, ревью B+C: упорный «клик без сверки» дальше добьют anti-runaway
    // и verify-петля, а не вечный круг ошибок).
    if (st.budget.lastAcquireWaitMs > STALE_INPUT_WAIT_MS && isBlindMutate(tu.name)) {
      const waitedSec = Math.round(st.budget.lastAcquireWaitMs / 1000);
      st.budget.staleGuardBlocks += 1;
      if (st.budget.staleGuardBlocks >= 2) st.budget.lastAcquireWaitMs = 0;
      st.progress.toolTrajectory.push(`${tu.name} (ошибка)`);
      round.resultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content:
          `Ввод освободился только после ${waitedSec}с ожидания — экран мог измениться. ` +
          `СНАЧАЛА сверь актуальное состояние (screen_capture / browser_read), потом действуй по свежему кадру.`,
        is_error: true,
      });
      return "continue";
    }
  }
  return "ok";
}

export function closeRound(ctx: LoopCtx, resp: LlmResponse, round: RoundResult): void {
  const { st, convo } = ctx;
  // Инвариант Anthropic: на КАЖДЫЙ tool_use ОБЯЗАТЕЛЕН парный tool_result. Ранний break по отмене
  // (выше) мог оставить часть tool_use без результата → дозаполняем заглушкой-ошибкой, иначе любой
  // путь, отправляющий этот convo дальше, упрётся в HTTP 400. Делаем инвариант безусловным.
  const answered = new Set(round.resultBlocks.map((b) => (b.type === "tool_result" ? b.tool_use_id : "")));
  for (const tu of resp.toolUses) {
    if (!answered.has(tu.id)) {
      // B-F6: честно — вызов НЕ исполнялся (журнал чекпойнта и модель не должны читать это как попытку с ошибкой).
      round.resultBlocks.push({ type: "tool_result", tool_use_id: tu.id, content: CANCELLED_RESULT, is_error: true });
    }
  }
  // Контроль-4: признаки вуали считаются ПО РАУНДУ, а не по одному вызову. Один overlay_drawing среди
  // ошибок раньше выкидывал ВЕСЬ раунд из §7-эскалации и глушил анти-капитуляцию — реальный not_found
  // соседнего инструмента маскировался вуалью (закон честности в обратную сторону). Теперь раунд «вуальный»,
  // только если КАЖДАЯ его ошибка — вуаль; раунд ожидания ПОД вуалью (сенсор/кадр veiled, ошибок нет) тоже
  // продлевает «остановка вуалью ≠ капитуляция» — честное «оверлей ещё открыт, дождусь» после раунда OCR
  // под вуалью ловилось нуджем «СДЕЛАЙ» и уводило на Opus.
  round.roundOverlayDenied = round.overlayDeniedIds.size > 0 && round.roundErrors === round.overlayDeniedIds.size;
  if (round.roundOverlayDenied || (round.roundVeiled && round.roundErrors === 0)) {
    st.honesty.gateStoppedRound = true;
    st.honesty.gateStoppedByVeil = true;
  }
  // Контроль-9 (background-running-gate-whole-round): «задание ещё идёт» гасит анти-капитуляцию/goal-check ТОЛЬКО
  // когда раунд без провалов — иначе реальные ошибки инструментов маскируются фоновым процессом (класс контроля-4).
  // Контроль-10 (background-wait-round-too-wide): «раунд ожидания» — только если ВЕСЬ раунд из опросов идущего
  // задания (правило контроля-4 «раунд вуальный, только если КАЖДАЯ его ошибка — вуаль»). Иначе один job_status
  // рядом с повторяющимся успешным кликом выключал identical-repeat: ни нуджа на 3-м, ни обрыва на 4-м.
  round.backgroundWaitRound =
    round.backgroundRunningIds.size > 0 && round.backgroundRunningIds.size === resp.toolUses.length && round.roundErrors === 0;
  if (round.backgroundWaitRound) st.honesty.gateStoppedRound = true;
  convo.push({ role: "user", content: round.resultBlocks });
}

export async function runToolRound(ctx: LoopCtx, resp: LlmResponse): Promise<RoundResult> {
  const { st, toolCtx, showStatus } = ctx;
  notifyToolRound(ctx.sink); // T-F6: sync-first промотирует ход в фон по ФАКТУ первого tool_use
  // Пошёл tool-use → это настоящая многошаговая задача: показываем прогресс (§20). Для содержательной
  // задачи чип УЖЕ показан на старте (выше); здесь — страховка + путь для conversational-хода, реально
  // делающего многошаговую работу инструментами (напр. «что у меня в памяти про X, разверни в план»).
  if (!st.progress.shown) showStatus();

  pushAssistantTurn(ctx, resp);
  const round = newRound();
  const prefetched = prefetchReadonly(ctx, resp);
  for (const raw of resp.toolUses) {
    // B-F6 (ревью 2026-09-24): отмена проверяется ПЕРЕД КАЖДЫМ вызовом, а не только перед GUI (аренда ввода).
    // Раньше «вырубись» посреди раунда останавливал лишь клики: отправка человеку, code_run, fs_delete из того
    // же раунда исполнялись ПОСЛЕ «Остановил». Недоисполненные вызовы закроет closeRound честным «отменено».
    if (ctx.task.cancel.cancelled) break;
    const tu = canonicalUse(raw); // W4 фасады: дальше по циклу — каноническое имя/вход; id — тот же (tool_result парен)
    const gate = await acquireForTool(ctx, tu, round);
    if (gate === "break") break;
    if (gate === "continue") continue;
    const settled = prefetched?.get(tu.id);
    const r = settled
      ? await settled.then((s) => {
          if (s.ok) return s.r;
          throw s.e; // семантика 1:1 с последовательным путём (исключение → внешний try петли)
        })
      : await dispatchTool(tu.name, tu.input, toolCtx);
    const { effOfCall, reportOfThisTurn } = noteToolCall(ctx, tu, r, round);
    if (!r.isError) applySuccessEffects(ctx, tu, r, effOfCall, round);
    applyRoundFlags(ctx, tu, r, effOfCall, reportOfThisTurn, round);
    round.resultBlocks.push({
      type: "tool_result",
      tool_use_id: tu.id,
      content: r.content,
      is_error: r.isError,
    });
  }
  closeRound(ctx, resp, round);
  return round;
}
