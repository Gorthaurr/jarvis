// W3 «Петля»: факты ОДНОГО раунда инструментов (вынесено из tool-round.ts, W2 П4: + стоп раунда G-8).
import type { LlmContentBlock } from "../../../integrations/llm.js";

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
  /** W2 (G-8): id мутации, после провала которой остальные мутации раунда НЕ исполняются (round-stop.ts). */
  stoppedBy?: string;
  /** W2 (G-8): заглушки «не исполнен» — не ошибки модели: ни roundErrors, ни §7 (round-classify) их не считают. */
  skippedIds: Set<string>;
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
    skippedIds: new Set<string>(),
  };
}
