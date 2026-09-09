/**
 * Хендлеры НАВЫКОВ (§8 HERMES) — вынесено из god-object dispatch.ts (§ревью).
 * skill_list/execute/save/promote: каталог + реплей по id (со слотами) + сохранение процедуры + промоут в общую.
 * §Волна2 (2.2): + input_batch — ad-hoc берст шагов через ТОТ ЖЕ skill-runner (одна аренда, один раунд).
 * Маршрутизация остаётся в dispatch (switch).
 */
import { REPLAY_TYPE_MAX_CHARS, SKILL_EXECUTE_SERVER_TIMEOUT_MS, type SkillStep, newId } from "@jarvis/protocol";
import { fillSlots } from "../../../memory/skill-slots.js";
import { isQuarantined } from "../../../memory/skills.js";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { type PostActionObservation, channelDownResult, overlayDeniedResult, confirmDeclineText, declined, formatObservationBlock, gateDeclined, err, ok, applyVeil, stripVeilFields } from "../dispatch-util.js";

/** Каталог выученных навыков для модели (id, имя, версия). */
export async function skillList(ctx: ToolContext): Promise<ToolResult> {
  const list = (await ctx.skills?.list(ctx.userId)) ?? [];
  if (list.length === 0) return ok("Выученных навыков пока нет.");
  return ok(
    list
      .map((s) => {
        const slots = s.slots?.length ? ` [переменные: ${s.slots.join(", ")}]` : "";
        return `- ${s.id}: «${s.name}» v${s.version}${s.needsReview ? " (требует подтверждения)" : ""}${slots}`;
      })
      .join("\n"),
  );
}

/** Запустить навык по id: сервер резолвит шаги/версию → эмитит skill.execute клиенту (§8). */
export async function skillExecute(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.skills) return err("навыки недоступны (нет провайдера)");
  const skillId = String(input.skillId ?? "").trim();
  if (!skillId) return err("skill_execute: нужен skillId (из skill_list)");
  const skill = await ctx.skills.get(ctx.userId, skillId);
  if (!skill) return err(`навык «${skillId}» не найден`);
  // Навык с guard-шагами (отправка/заказ/код) — подтверждение перед запуском (§14).
  if (skill.needsReview) {
    if (!ctx.confirm) return err(`навык «${skillId}» содержит необратимые шаги — нужно подтверждение (§14), но канал недоступен`);
    const gate = await ctx.confirm(`Запустить навык «${skillId}»? Он содержит необратимые шаги.`, "irreversible");
    if (!gate.approved) return gateDeclined(confirmDeclineText(gate.outcome, `навык ${skillId}`), gate.outcome);
  }
  const params = input.params && typeof input.params === "object" ? (input.params as Record<string, unknown>) : {};
  // §8 параметризация: подставить переменные {{slot}} в шаги ДО исполнения. Честность: если навык
  // ссылается на слоты, которых нет в params — НЕ исполняем (иначе актуатор получит литерал «{{contact}}»),
  // а просим модель дозаполнить. Литеральный навык (без слотов) проходит как есть.
  const { steps, missing } = fillSlots(skill.steps, params);
  if (missing.length > 0) {
    return err(`навык «${skillId}»: не заполнены переменные ${missing.map((m) => `{{${m}}}`).join(", ")} — передай их значения в params.`);
  }
  // Ревью фиксов Волны 3 (#12): клиент гонит runSkill под бюджетом 90с на ЛЮБОЙ skill.execute —
  // прежний дефолтный таймаут 15с отваливался ПЕРВЫМ, и LLM-петля начинала кликать параллельно
  // ещё идущему реплею («два писателя в GUI»). Ждём строго дольше клиентского бюджета.
  const result = await ctx.session.sendAction(
    { kind: "skill.execute", skillId: skill.id, version: skill.version, steps, params },
    SKILL_EXECUTE_SERVER_TIMEOUT_MS,
  );
  // Б4 (ревью #4): канал ПК мёртв (resume-grace) → помечаем channelDown, чтобы петля ждала reconnect,
  // а не эскалировала тир («Opus от транспорта»). Хендлер обходит generic-путь dispatch — делаем сами.
  const cd = channelDownResult(result, `Навык «${skillId}» не отправлен: канал с ПК недоступен (переподключение).`);
  if (cd) return cd;
  // Контроль-3: шаг лёг об вуаль режима выделения — состояние системы, не сбой навыка (иначе §7-эскалация).
  // Контроль-4: шаги ДО остановки уже исполнены (мутации!) — «повтори» без номера шага давало бы дубль
  // напечатанного/отправленного; называем, где остановились, и что НЕ откатывается (как у input_batch).
  const kv = typeof result.stepIndex === "number" ? result.stepIndex : 0;
  const od = overlayDeniedResult(
    result,
    result.stepActionInjected === true
      ? // Контроль-5 (S1): вуаль поймала РЕТРАЙ/сверку постусловия — действие шага уже инжектировано, исход неизвестен.
        // Контроль-6 (V5-4): стадию не утверждаем — по бинарному признаку «до сверки» от «на ретрае» не отличить.
        `Навык «${skillId}» остановлен вуалью на шаге ${kv + 1}: действие этого шага УЖЕ УШЛО в GUI, сверить его исход под ` +
        `вуалью нельзя — ИСХОД НЕИЗВЕСТЕН, шаг НЕ повторяй вслепую. ${kv > 0 ? `Сделанные ${kv} шагов УЖЕ ВЫПОЛНЕНЫ и не откатываются. ` : ""}` +
        `Дождись закрытия оверлея (screen_selection{op:"start", waitMs} или спроси владельца), СВЕРЬ состояние и продолжай по факту.`
      : kv > 0
      ? `Навык «${skillId}» остановлен на шаге ${kv + 1}: поверх экрана вуаль режима выделения — физический ввод не ` +
          `инжектируется, пока открыт оверлей. Сделанные ${kv} шагов УЖЕ ВЫПОЛНЕНЫ и НЕ откатываются — не повторяй их; ` +
          `дождись закрытия оверлея (screen_selection{op:"start", waitMs} или спроси владельца), сверь состояние и ` +
          `продолжай с шага ${kv + 1}.`
      : `Навык «${skillId}» НЕ выполнен: поверх экрана вуаль режима выделения — физический ввод не инжектируется, ` +
          `пока открыт оверлей (владелец обводит область или оверлей ждёт его). Это состояние системы, не сбой навыка и ` +
          `не «экран изменился»: дождись закрытия оверлея (screen_selection{op:"start", waitMs} или спроси владельца) ` +
          `и повтори; шаги вслепую не дублируй.`,
  );
  if (od) return od;
  // Таймаут КАНАЛА ≠ «не выполнено»: клиент мог продолжать исполнять шаги — статус неизвестен.
  if (!result.ok && result.error?.code === "timeout") {
    // Контроль-9 (skill-timeout-no-uncertain): текст говорил «СТАТУС НЕИЗВЕСТЕН», а на результате не было НИ ОДНОГО
    // структурного признака — журнал прерванной задачи печатал такому вызову «ОШИБКА» в НЕСОКРАЩАЕМОЙ секции
    // «СДЕЛАНО», то есть «не сделано», и «доделай» повторяло шаги, которые могли уже уйти в GUI.
    const outT = err(
      `Навык «${skillId}» не уложился в ${Math.round(SKILL_EXECUTE_SERVER_TIMEOUT_MS / 1000)}с — СТАТУС НЕИЗВЕСТЕН ` +
        `(шаги могли выполниться и ещё выполняться). НЕ повторяй навык и не дублируй его шаги вслепую: ` +
        `сверь текущее состояние (ui_snapshot/screen_capture) и действуй по факту.`,
    );
    outT.uncertain = true; // контроль-10: `partialSteps` здесь был МЁРТВ — синтетический таймаут канала stepIndex не несёт
    return outT;
  }
  if (result.ok) {
    // §Волна2 (2.1, ревью M11): fused-наблюдение после реплея — текст С ЭКРАНА, в tool_result
    // только под <untrusted_content> (сырой JSON.stringify пробивал бы границу данные/инструкции).
    const data = result.data as { observation?: PostActionObservation } | undefined;
    const obs = data?.observation;
    if (obs?.text) {
      const { observation: _o, ...rest } = data!;
      const restClean = stripVeilFields(rest as Record<string, unknown>); // контроль-6 (V5-5)
      const restJson = Object.keys(restClean).length > 0 ? ` ${JSON.stringify(restClean)}` : "";
      // M11: заголовок окна — влияемые данные → внутрь untrusted-блока (внутри общего хелпера).
      // Ревью 2026-09-01: своя копия текста подписывала ДЕЛЬТУ как «состояние», а «изменений нет» —
      // как «текста не распознано»; модель делала вывод «сенсор ослеп» и шла за скриншотом.
      const out = ok(`Навык «${skillId}» выполнен.${restJson}\n${formatObservationBlock(obs, "Наблюдение после реплея")}`);
      if (obs.weak !== true) out.observed = true;
      applyVeil(out, result.data); // контроль-4: наблюдение с окна оверлея — не сверка
      return out;
    }
    return ok(result.data !== undefined ? JSON.stringify(result.data) : `Навык «${skillId}» выполнен.`);
  }
  // Контроль-6 (V5-3): обычный провал на шаге k+1 — как у берста: k сделанных шагов НЕ откатываются, а действие
  // шага k+1 могло уйти (Enter с ретраями) — «не выполнен» без этого вело к повтору skill_execute целиком.
  return stepFailure(`Навык «${skillId}»`, steps.length, steps, result);
}

/** Срезать клиентский префикс/хвост с номером шага — в одной фразе номер шага называется ОДИН раз (контроль-5 S2, -6 V5-6). */
export function stripStepPrefix(msg: string): string {
  return msg
    .replace(/^шаг \d+ \([^)]*\)\s*:?\s*/u, "") // контроль-7 (sensors-7): и «шаг N (a) требует LLM…», не только «: …»/«не подтвердил»
    .replace(/\s*\(шаг \d+(?:,\s*([^)]*))?\)\s*$/u, (_m, tail: string | undefined) => (tail ? ` (${tail})` : "")) // суть скобки остаётся
    .trim();
}

/**
 * Единый честный текст провала реплея/берста на шаге k+1 (контроль-6, DRY для skill_execute и input_batch):
 * k сделанных НЕ откатываются; ушедшее действие шага k+1 = ИСХОД НЕИЗВЕСТЕН (ToolResult.uncertain — журнал не
 * прочтёт «ОШИБКА» как «не сделано» и не повторит).
 */
function stepFailure(
  what: string,
  n: number,
  steps: ReadonlyArray<{ action: string }>,
  result: { stepIndex?: number; stepActionInjected?: boolean; error?: { code?: string; message?: string } },
): ToolResult {
  const k = typeof result.stepIndex === "number" ? result.stepIndex : 0;
  const injected = result.stepActionInjected === true;
  const reason = stripStepPrefix(result.error?.message ?? result.error?.code ?? "ошибка");
  const done = k > 0 ? ` Сделанные ${k} шагов НЕ откатываются.` : "";
  const went = injected ? ` Действие шага ${k + 1} УХОДИЛО в GUI (до всех попыток) — его ИСХОД НЕ ПОДТВЕРЖДЁН, не повторяй вслепую.` : "";
  const out = err(
    `${what} остановлен: выполнено ${k} из ${n}, шаг ${k + 1} («${steps[k]?.action ?? "?"}») не прошёл — ${reason}.${done}${went} ` +
      `Сверь текущее состояние (ui_snapshot/screen_capture) и продолжай с места остановки, не повторяя сделанное.`,
  );
  // Контроль-8 (step-failure-journal): k исполненных шагов обязан знать и ЖУРНАЛ, а не только текст для модели —
  // иначе прерванная задача печатает «input_batch — ОШИБКА», и «доделай» повторяет набор и клики.
  if (k > 0) out.partialSteps = k;
  if (injected) {
    out.partialInjected = true;
    out.uncertain = true;
  }
  return out;
}

// §Волна2 (2.2): действия, разрешённые в ad-hoc берсте. Только то, что skill-runner исполняет
// ДЕТЕРМИНИРОВАННО и БЕЗОПАСНО; незнакомое действие клиент-актуатор молча пропустил бы (no-op) —
// ложный успех, поэтому валидация ЗДЕСЬ, до отправки (§честность).
const BATCH_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  "app.launch", "app.focus", "browser.open",
  "ui.invoke", "ui.ground",
  "input.type", "input.key", "input.click", "input.mouse",
  "wait", "ground", "verify",
]);
const BATCH_MAX_STEPS = 12;

/**
 * §Волна2 (2.2) input_batch: серия механических шагов ОДНИМ tool-вызовом — клиентский skill-runner
 * исполняет их под одной арендой ввода, стоп на первой неподтверждённой (expect) ошибке, честный
 * итог «выполнено k из n». Форма/цепочка хоткеев = 1 LLM-раунд вместо 5. Синтетический skillId —
 * это НЕ сохранённый навык, а ad-hoc берст (ничего не персистится).
 */
export async function inputBatch(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const rawSteps = Array.isArray(input.steps) ? (input.steps as Array<Record<string, unknown>>) : null;
  if (!rawSteps || rawSteps.length === 0) return err("input_batch: нужен steps[] (1..12 шагов)");
  if (rawSteps.length > BATCH_MAX_STEPS) {
    return err(`input_batch: слишком длинный берст (${rawSteps.length} шагов, максимум ${BATCH_MAX_STEPS}) — компаундинг-риск, разбей на части со сверкой между ними.`);
  }
  const steps: SkillStep[] = [];
  for (let i = 0; i < rawSteps.length; i += 1) {
    const s = rawSteps[i]!;
    const action = String(s.action ?? "").trim();
    if (!BATCH_ALLOWED_ACTIONS.has(action)) {
      return err(
        `input_batch: шаг ${i + 1} — действие «${action}» в берсте не поддерживается. ` +
          `Разрешены: ${[...BATCH_ALLOWED_ACTIONS].join(", ")}. Прочее делай отдельными инструментами.`,
      );
    }
    if (s.needsLlm) return err(`input_batch: шаг ${i + 1} с needsLlm в ad-hoc берсте невозможен — заполни значения сам.`);
    // Ревью фиксов, 2-й проход (R2): длинный input.type НЕотменяем (typeText даёт себе 5с+120мс/символ,
    // до 180с > серверного потолка 130с) → печатал бы параллельно LLM-петле в уже другое окно.
    const params = s.params && typeof s.params === "object" ? (s.params as Record<string, unknown>) : undefined;
    if (action === "input.type" && typeof params?.text === "string" && params.text.length > REPLAY_TYPE_MAX_CHARS) {
      return err(
        `input_batch: шаг ${i + 1} — текст input.type длиннее ${REPLAY_TYPE_MAX_CHARS} символов не батчится ` +
          `(печать неотменяема и не влезает в бюджет реплея). Длинный текст — через fs_write/office_* или обычный input_type.`,
      );
    }
    const expect = (s.expect && typeof s.expect === "object" ? s.expect : undefined) as SkillStep["expect"];
    // Ревью Волны 2: expect без содержимого «подтверждается» безусловно (checkExpect: нет role →
    // true) — итоговое «постусловия подтверждены» было бы ложью. Требуем role (a11y) / text (visual).
    if (expect) {
      const isVisual = expect.kind === "visual";
      if (isVisual && !expect.text) return err(`input_batch: шаг ${i + 1} — expect visual без text (нечего проверять).`);
      if (!isVisual && !expect.role) return err(`input_batch: шаг ${i + 1} — expect a11y без role (нечего проверять).`);
    }
    // ui.ground в берсте исполняется только с target.by="role" (иначе клиент делает тихий no-op).
    const target = s.target as SkillStep["target"];
    if (action === "ui.ground" && target?.by !== "role") {
      return err(`input_batch: шаг ${i + 1} — ui.ground требует target {by:"role", role, name?}.`);
    }
    steps.push({
      action,
      target,
      params: (s.params && typeof s.params === "object" ? s.params : undefined) as SkillStep["params"],
      expect,
      // §Волна3 (3.3): предусловие шага — живой стейт до исполнения (валидирует клиентский раннер).
      precondition: (s.precondition && typeof s.precondition === "object" && typeof (s.precondition as { role?: unknown }).role === "string"
        ? s.precondition
        : undefined) as SkillStep["precondition"],
      timeoutMs: typeof s.timeoutMs === "number" ? s.timeoutMs : undefined,
      // Ревью Волны 2: у слепого шага (без expect) НЕТ критерия неудачи → ретраи переисполняли бы
      // неидемпотентное действие (тройной клик/ввод). Без expect — 0 повторов по умолчанию.
      // Ревью фиксов, 2-й проход (R3): retries из контента клампим — без капа sleep(200·attempt)
      // между попытками раздувал хвостовой перебег за серверный потолок.
      retries: typeof s.retries === "number" ? Math.max(0, Math.min(3, Math.floor(s.retries))) : expect ? undefined : 0,
    });
  }
  // Ревью фиксов Волны 3 (#12): расчётный «от объёма берста» таймаут мог быть КОРОЧЕ клиентского
  // бюджета runSkill (90с на любой skill.execute) → сервер отваливался первым и петля кликала
  // параллельно ещё идущему берсту. Единый потолок строго выше клиентского бюджета; нормальное
  // завершение возвращается раньше — потолок платится только на реально зависшем берсте.
  const timeoutMs = SKILL_EXECUTE_SERVER_TIMEOUT_MS;
  const result = await ctx.session.sendAction(
    // origin — как у прочих команд (H5: USER_BUSY-гейт проактивного берста на клиенте).
    { kind: "skill.execute", skillId: `adhoc-batch-${newId()}`, version: 0, steps, params: {}, origin: ctx.origin ?? "user" },
    timeoutMs,
  );
  const n = steps.length;
  // Б4 (ревью #4): канал ПК мёртв → channelDown (петля ждёт reconnect, не эскалирует тир).
  const cdb = channelDownResult(result, "Берст не отправлен: канал с ПК недоступен (переподключение).");
  if (cdb) return cdb;
  // Контроль-3: шаг лёг об вуаль режима выделения — состояние системы, не провал шага (иначе §7-эскалация).
  const k0 = typeof result.stepIndex === "number" ? result.stepIndex : 0;
  const odb = overlayDeniedResult(
    result,
    result.stepActionInjected === true
      ? `Берст остановлен вуалью на шаге ${k0 + 1} из ${n}: действие этого шага УЖЕ УШЛО в GUI, сверить его исход под вуалью ` +
        `нельзя — ИСХОД НЕИЗВЕСТЕН, шаг НЕ повторяй вслепую.${k0 > 0 ? ` Сделанные ${k0} шагов не откатываются.` : ""} Дождись закрытия ` +
        `оверлея, СВЕРЬ состояние (ui_snapshot/screen_capture) и продолжай по факту.`
      : `Берст остановлен на шаге ${k0 + 1} из ${n}: поверх экрана вуаль режима выделения — физический ввод не ` +
      `инжектируется, пока открыт оверлей. Это состояние системы, не провал шага: сделанные ${k0} шагов НЕ ` +
      `откатываются; дождись закрытия оверлея (screen_selection{op:"start", waitMs} или спроси владельца) и ` +
      `продолжай с места остановки, не повторяя сделанное.`,
  );
  if (odb) return odb;
  // Таймаут КАНАЛА ≠ «выполнено 0 из n»: клиент мог продолжать исполнять шаги — статус неизвестен.
  if (!result.ok && result.error?.code === "timeout") {
    // Контроль-9 (skill-timeout-no-uncertain): зеркало skill_execute — «статус неизвестен» обязан дойти до журнала
    // отдельной меткой, иначе «ОШИБКА» читается продолжением как «не сделано».
    const outT = err(
      `Берст не уложился в ${Math.round(timeoutMs / 1000)}с — СТАТУС НЕИЗВЕСТЕН (часть шагов могла выполниться ` +
        `и ещё выполняться). НЕ повторяй берст вслепую: сверь текущее состояние (ui_snapshot/screen_capture) и действуй по факту.`,
    );
    outT.uncertain = true; // контроль-10: то же — таймаут КАНАЛА номера шага не знает
    return outT;
  }
  if (result.ok) {
    // §Волна2 (2.1): клиент прикладывает наблюдение после последнего шага → сверка в том же раунде.
    const data = result.data as { observation?: PostActionObservation } | undefined;
    const obs = data?.observation;
    const out = ok(
      `Берст выполнен: все ${n} шагов прошли (expect-постусловия подтверждены там, где заданы).` +
        (obs?.text ? `\n${formatObservationBlock(obs, "Наблюдение после берста")}` : ""),
    );
    // Слабое наблюдение (пустой OCR) verify-долг не снимает (ревью Волны 2).
    if (obs && obs.weak !== true) out.observed = true;
    applyVeil(out, result.data); // контроль-4: наблюдение с окна оверлея — не сверка
    return out;
  }
  return stepFailure("Берст", n, steps, result);
}

/**
 * Сохранить выученный навык-процедуру (§8 HERMES): Джарвис сам пишет памятку {name, when, procedure} после
 * того, как разобрался со сложной задачей. НЕ реплей — навык recall'ится как текст-руководство в начале похожей
 * задачи. Повторное сохранение того же имени — новая версия (улучшение, + мульти-демо дистилляция).
 */
export async function skillSave(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.skills) return err("сохранение навыков недоступно (нет провайдера)");
  const name = String(input.name ?? "").trim();
  const when = String(input.when ?? "").trim();
  const procedure = String(input.procedure ?? "").trim();
  if (!name || !procedure) return err("skill_save: нужны name и procedure");
  const saved = await ctx.skills.save(ctx.userId, { name, when, procedure });
  if (!saved) return err("не удалось сохранить навык");
  if (isQuarantined(saved)) {
    // F2 (волна F): скан нашёл в контенте признаки инъекции — навык НЕ записан, текст в карантине
    // (data/skills/_quarantine) для ревью владельцем. Честная ошибка, НЕ ложный «сохранён»; повтор
    // того же текста упрётся в тот же скан — не переформулируй директиву, а выбрось её из процедуры.
    const rules = saved.findings.map((f) => f.rule).join(", ");
    // Про карантин говорим, только если улика РЕАЛЬНО легла на диск (запись fail-safe) — иначе
    // обещали бы владельцу файл, которого нет (контроль-2).
    const where = saved.stored === false ? "Записать текст в карантин не удалось — он потерян." : "Текст отложен в карантин для владельца.";
    return err(
      `навык НЕ сохранён: в тексте признаки инъекции (${rules}) — такие приказы не место в процедуре. ` +
        `${where} Сохрани процедуру БЕЗ этих директив.`,
    );
  }
  const out = ok(`Навык «${saved.name}» сохранён (v${saved.version}). В следующий раз применю его сам.`);
  out.data = { id: saved.id }; // §8 МАКРОС: agent-петля дописывает в свежесохранённый навык авто-реплей жестов
  return out;
}

/**
 * Поднять СВОЙ выученный навык в ОБЩУЮ библиотеку (§мультитенант): после этого приём виден всем через recall.
 * Поднимаем только свои выученные процедуры (owner-check + не реплей).
 */
export async function skillPromote(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.skills?.promote) return err("повышение навыков недоступно (нет провайдера)");
  const skillId = String(input.skillId ?? "").trim();
  if (!skillId) return err("skill_promote: нужен skillId (из skill_list)");
  const r = await ctx.skills.promote(ctx.userId, skillId);
  if (r.ok) return ok(`Навык «${r.name}» теперь в общей библиотеке — им смогут пользоваться все.`);
  const reason =
    r.reason === "not_found"
      ? `навык «${skillId}» не найден среди твоих`
      : r.reason === "not_learned"
        ? "в общую библиотеку можно поднять только выученную процедуру (не записанный показом реплей)"
        : r.reason === "already_shared"
          ? "это уже общий навык"
          : r.reason === "blocked_scan"
            ? "скан нашёл в навыке признаки инъекции — в общую библиотеку не поднимаю (F2); пересохрани навык без директив"
            : "не удалось поднять навык в общую библиотеку";
  return err(reason);
}
