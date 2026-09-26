// W1 (L-3) + W1-ревью р2 (loop-bypass-4): «сверено ли ДЕЛО, а не только запуск» — учёт по вызовам (tool-classify) и
// заявка финала «только о запуске» (goal-check, nudge-policy.ts). Живой случай 2026-07-02: «запусти поиск в доте» →
// app_launch → скрин меню → «Дота запущена, сэр» — сверена ПОДЦЕЛЬ (запуск), не цель (поиск матча).
// L-3 снял лишний goal-check после сверенного дела («Открыл блокнот и напечатал X» после act met), но флагом на всю
// задачу: сверенная ПОДГОТОВИТЕЛЬНАЯ рука (закрыть попап) гасила сверку и у «Дота запущена» — случай 07-02 вернулся.
// Теперь сверенное дело снимает «заявку о запуске», только если (1) финал САМ заявляет дело сверх запуска (глагол-дело,
// а не «запущена/открыл X») и (2) после дела не было нового запуска/фокуса (иначе дело — из прошлой подготовки).
import type { HonestyState } from "./state.js";
import type { ToolResult } from "../../tools/dispatch.js";
import type { LlmResponse } from "../../../integrations/llm.js";
import { LAUNCH_ONLY_TOOLS, isBlindMutate } from "../error-voice.js";

/** Слова запуска/открытия в любом месте финала («запущена», «открыл», «поднялся»). */
const LAUNCH_CLAIM = /(?<![\p{L}])(запущен|запустил|поднялс|стартовал|открыл)\p{L}*/iu;
const LAUNCH_WORD = /^(?:запущен|запустил|поднялс|стартовал|открыл)/u;
/** Глагол-дело Джарвиса о себе: прош. время, муж. род, не возвратный («напечатал», «нажал», «ввёл», «нашёл»). */
const DEED_VERB = /^\p{L}{2,}[аяеёиуы]л$/u;

/**
 * Финал заявляет СВОЁ дело сверх запуска: глагол-дело, не слово запуска и не объект сразу после него («Открыл
 * терминал» — терминал не дело). Цитаты в кавычках не смотрим (текст чужой).
 */
export function claimsDeedBeyondLaunch(text: string): boolean {
  const words = text.replace(/«[^»]*»|"[^"]*"/gu, " ").toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.some((w, i) => DEED_VERB.test(w) && !LAUNCH_WORD.test(w) && !(i > 0 && LAUNCH_WORD.test(words[i - 1] ?? "")));
}

/** Финал звучит как запуск/открытие и не заявляет сверенного дела сверх него → goal-check даже после verify-раунда. */
export function launchOnlyClaim(text: string, h: HonestyState): boolean {
  return LAUNCH_CLAIM.test(text) && !(h.verifiedRealAction && claimsDeedBeyondLaunch(text));
}

/**
 * Учёт одного успешного вызова. Не-запускной mutate РУКИ с приложенным наблюдением (act verified:"met", readback поля)
 * — сверен сразу; без наблюдения — ждёт реального взгляда. Коммит отправки своим снимком себя не сверяет (снимок =
 * факт нажатия). Запуск/фокус ПОСЛЕ дела — новая подготовка: прежнее дело к финалу о запуске не относится (р2).
 */
export function noteRealAction(h: HonestyState, tu: LlmResponse["toolUses"][number], r: ToolResult, eff: "verify" | "mutate" | "neutral", realVerify: boolean, selfObserved: boolean): void {
  if (realVerify && h.realActionUnverified) {
    h.verifiedRealAction = true;
    h.realActionUnverified = false;
  }
  if (eff !== "mutate" || r.declined === true || r.uncertain === true) return;
  if (LAUNCH_ONLY_TOOLS.has(tu.name)) {
    h.verifiedRealAction = false;
    h.realActionUnverified = false;
    return;
  }
  // Только РУКИ (слепые mutate: act/browser_act/input_*…): самоподтверждающийся mutate (громкость, код, файл) себя уже
  // подтвердил, и взгляд после него не делает «Запустил Доту» сверенным делом (app_launch → system_volume → скрин).
  if (!isBlindMutate(tu.name)) return;
  if (selfObserved) h.verifiedRealAction = true;
  else h.realActionUnverified = true;
}
