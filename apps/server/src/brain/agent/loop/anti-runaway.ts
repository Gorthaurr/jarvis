// W3 «Петля»: anti-runaway: повтор одного действия и флуд одним семейством инструментов.
import { log } from "./util.js";
import type { LoopCtx } from "./context.js";
import type { RoundResult } from "./tool-round.js";
import type { RoundSummary } from "./round-classify.js";
import type { LlmResponse } from "../../../integrations/llm.js";

export function antiRunawayIdentical(ctx: LoopCtx, summary: RoundSummary): "break" | "next" {
  const { st, pushSystemNote } = ctx;
  const { allErrored, toolSig, veiledWaitRound } = summary;
  if (veiledWaitRound) {
    // ни повтор, ни сброс серии — как у провального раунда (!allErrored)
  } else if (toolSig === st.nudge.lastToolSig && !allErrored) {
    st.nudge.identicalRepeats += 1;
    if (st.nudge.identicalRepeats >= 2) {
      if (!st.nudge.repeatNudged) {
        st.nudge.repeatNudged = true;
        const nudge =
          "СТОП. Ты повторяешь ОДНО И ТО ЖЕ действие с тем же вводом — значит, цель, скорее всего, НЕ достигается. НЕ повторяй его снова. Сверь реальное состояние глазами (browser_read / screen_capture): цель достигнута → заверши и подтверди фактом; НЕ достигнута → смени подход (другой инструмент / другой путь).";
        // Как family-нудж: дописываем text-блок в ТЕКУЩЕЕ user-сообщение с tool_result.
        pushSystemNote(nudge);
        log.warn("anti-runaway: повтор одинакового действия — нудж на сверку/смену подхода", { tool: toolSig.slice(0, 80) });
        st.tier.nudgeBoostNextRound = true; // §2.7: следующий раунд — переосмысление, думаем полноценно
        st.tier.cleanRoundsStreak = 0; // §Волна3 (3.2): топтание = не «чистая механика», executor вниз не идёт
      } else {
        log.warn("повтор одного успешного действия после нуджа — обрыв петли (честный провал)", { tool: toolSig.slice(0, 80) });
        st.exit.runawayStuck = true;
        return "break";
      }
    }
  } else {
    st.nudge.identicalRepeats = 0;
  }
  if (!veiledWaitRound) st.nudge.lastToolSig = toolSig;
  return "next";
}

export function familyCap(ctx: LoopCtx, resp: LlmResponse, round: RoundResult): "break" | "next" {
  const { deps, tier, st, pushSystemNote } = ctx;
  const { FAMILY_SOFT_CAP, MAX_FAMILY_NUDGES } = ctx.cfg;
  // Мягкий anti-runaway по СЕМЕЙСТВУ инструментов (фикс «дублирует команды»): один tool NAME вызван
  // слишком много раз за задачу → флуд без сходимости. Сначала интервент-нудж (смени подход / оцени, не
  // достигнута ли цель) + эскалация на Opus; при упорстве — честный обрыв ДО упора в max_steps(50).
  for (const tu of resp.toolUses) {
    if (round.overlayDeniedIds.has(tu.id) || round.veiledIds.has(tu.id) || round.backgroundRunningIds.has(tu.id)) continue; // контроль-3/5/9: отказ вуали, опрос под ней и опрос идущего задания — состояние системы, не «топтание»
    if (tu.name === "file_view") {
      const inp = tu.input as { path?: unknown; page?: unknown };
      const sig = `${String(inp.path ?? "")}#${String(inp.page ?? 1)}`;
      if (!st.nudge.seenFileViews.has(sig)) {
        st.nudge.seenFileViews.add(sig);
        continue;
      }
    }
    st.nudge.toolNameCount.set(tu.name, (st.nudge.toolNameCount.get(tu.name) ?? 0) + 1);
  }
  const worst = [...st.nudge.toolNameCount.entries()].sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] >= FAMILY_SOFT_CAP * (st.nudge.familyNudges + 1)) {
    if (st.nudge.familyNudges < MAX_FAMILY_NUDGES) {
      st.nudge.familyNudges += 1;
      const nudge =
        `СТОП. Ты вызвал «${worst[0]}» ${worst[1]} раз — похоже на топтание на месте без результата. ОЦЕНИ ТРЕЗВО: цель УЖЕ достигнута? Тогда заверши и подтверди фактом. Если НЕТ — повтор того же НЕ помогает: СМЕНИ подход (другой инструмент / прямой URL / code_run / прочитай реальное состояние и действуй точечно), не долби одно и то же.`;
      // Добавляем как text-блок в ТЕКУЩЕЕ user-сообщение с tool_result (не плодим второй user-ход).
      pushSystemNote(nudge);
      log.warn("anti-runaway (семейство): интервент-нудж — смени подход", { tool: worst[0], count: worst[1], familyNudges: st.nudge.familyNudges });
      st.tier.nudgeBoostNextRound = true; // §2.7: следующий раунд — переосмысление, думаем полноценно
      st.tier.cleanRoundsStreak = 0; // §Волна3 (3.2): флуд одним инструментом = не «чистая механика»
      if (st.tier.currentTier !== "fable" && deps.models.fable !== st.tier.model) {
        // §скорость: усиление КОРОТКОЕ — 2 раунда переосмысления на сильной модели, затем откат
        // (см. familyBoost в шапке петли). Липкий Opus замедлял всю оставшуюся механику; но 1 раунд
        // (Волна 1, ревью кеша) дважды переписывал весь кеш-префикс (свитч модели = отдельный
        // кеш-неймспейс) ради ЕДИНСТВЕННОГО хода — 2 раунда амортизируют перезапись и дают
        // сильной модели закончить мысль (переосмысление + первый шаг нового подхода).
        st.tier.familyBoost = { tier: st.tier.currentTier, model: st.tier.model, roundsLeft: 2 };
        st.tier.currentTier = "fable";
        st.tier.model = deps.models.fable; // на переосмыслении — сильная модель
      }
    } else {
      log.warn("anti-runaway (семейство): обрыв петли — флуд не остановился", { tool: worst[0], count: worst[1] });
      // 🔴 Это ПРОВАЛ, а не успех: раньше ни один флаг не выставлялся, ход доходил до УСПЕШНОГО
      // терминала (`tasks.finish`, ok=true в метриках) и — уже с волной C — ещё и ГАСИЛ чекпойнт
      // продолжения: владельцу говорили «не довёл», а система записывала «сделано».
      // ⚠️ ПРЕАМБУЛУ МОДЕЛИ НЕ ПЕРЕИСПОЛЬЗУЕМ (контроль-6, HIGH — второй заход на тот же класс):
      // family-нудж прямо просит «цель достигнута? подтверди фактом», и типовой ответ — «Готово, сэр —
      // отчёт собран.» + ещё один вызов флудящего инструмента, который и добивает кап. `isHollowSuccess`
      // такую фразу НЕ ловит (>3 слов — «доверяем модели»), и владелец слышал УСПЕХ при `failed`, а
      // ложное «собран» оседало в рабочей памяти. Терминал ведёт СВОЕЙ честной фразой — как это давно
      // делают братья runawayStuck/maskedFailure, которые текст модели не переиспользуют вовсе.
      st.exit.floodTool = worst[0];
      st.exit.floodStuck = true;
      return "break";
    }
  }
  return "next";
}
