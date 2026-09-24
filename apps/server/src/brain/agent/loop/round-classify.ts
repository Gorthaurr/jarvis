// W3 «Петля»: чистая сводка раунда: провалы, сигнатура повтора, ожидание под вуалью/фонового задания.
import type { RoundResult } from "./tool-round.js";
import type { LlmResponse } from "../../../integrations/llm.js";
import { repeatSignature } from "../repeat-key.js";

export interface RoundSummary { allErrored: boolean; anyErrored: boolean; toolSig: string; veiledWaitRound: boolean }

/** ЧИСТАЯ сводка раунда: только по результатам и фактам раунда, состояние петли не трогает. */
export function summarizeRound(resp: LlmResponse, round: RoundResult): RoundSummary {
  // Эскалация тира (§7): если раунд провалился ЦЕЛИКОМ (все инструменты вернули ошибку)
  // ESCALATE_AFTER раз подряд — модель застряла → заходим сильнее (haiku→sonnet→fable),
  // вместо того чтобы сдаться на слабой модели. Один успешный инструмент сбрасывает счётчик.
  const allErrored =
    round.resultBlocks.length > 0 && round.resultBlocks.every((b) => b.type === "tool_result" && b.is_error === true);
  // §Волна3 (3.2) + ревью Волны 3 (#4): «чистый раунд» для executor-отката = НИ ОДНОГО провалившегося
  // инструмента. Раньше считалось «не ВСЕ упали» (allErrored) → смешанный раунд (слепой input_click
  // is_error + screen_read_text ok) РОС streak, хотя КЛЮЧЕВОЕ действие валилось — даунгрейд возвращал
  // слабый тир под продолжающийся провал (пинг-понг эскалация↔откат). Любая ошибка в раунде = не
  // «чистая механика» (transient-сбой чтения лишь отложит откат на пару раундов — консервативно/безопасно).
  const anyErrored = round.resultBlocks.some((b) => b.type === "tool_result" && b.is_error === true);
  // Anti-runaway (§20): модель повторяет ТОТ ЖЕ УСПЕШНЫЙ tool-вызов раунд за раундом
  // («открывает до посинения», карточка задачи не закрывается). H4 (ревью 2026-07-02): такой повтор —
  // типичный признак, что цель НЕ достигается, поэтому прежний обрыв с дефолтом «Готово, сэр.» был
  // ложным успехом в обход verify-петли. Теперь: на 3-м одинаковом — ОДИН интервент-нудж (сверь
  // глазами / смени подход), при упорстве — честный обрыв С ПРОВАЛОМ (терминал runawayStuck).
  // Падающие повторы НЕ трогаем (ими занимается эскалация тира выше); разный input — сброс.
  // Сигнатура НОРМАЛИЗОВАННАЯ (волна F F1): перестановка ключей/пробелы/свежий nonce не делают
  // повтор «новым действием» — см. repeat-key.ts.
  const toolSig = repeatSignature(resp.toolUses);
  // Контроль-5 (V4-4): опрос под вуалью (wait_for/OCR/кадр, ошибок нет) — ОЖИДАНИЕ владельца, а не «одно и то же
  // без результата»: раньше 3-й опрос получал нудж, 4-й — runawayStuck и failed, пока владелец ещё обводил.
  // Контроль-9 (background-poll-runaway): схема code_run САМА велит опрашивать job_status до `running:false`, а
  // anti-runaway считал одинаковые опросы «одним и тем же без результата»: на 3-м шёл нудж «смени подход», на 4-м —
  // runawayStuck и «Застрял, не довёл» про исправно идущее задание. Ожидание процесса — той же природы, что
  // ожидание владельца под вуалью, и обрабатывается той же веткой.
  const veiledWaitRound = (round.roundVeiled && round.roundErrors === 0) || round.backgroundWaitRound;
  return { allErrored, anyErrored, toolSig, veiledWaitRound };
}
