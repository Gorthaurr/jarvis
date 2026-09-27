/**
 * W3 (L-2): слепая рука — по ВЫЗОВУ, а не только по имени. code_run с `import jarvis` кликает и печатает через мост
 * актуаторов теми же SendInput/UIA, что act/input_*, а его «ok» (exit 0) говорит лишь, что скрипт не упал, — не что
 * цель достигнута. Такой вызов, как и act без наблюдения, оставляет долг сверки глазами; самописный инструмент на SDK
 * — так же (его код резолвит code-input.ts из реестра владельца). Прочий код самоподтверждается своим выводом.
 * Потребители: долг сверки (tool-classify, send-gesture), «сверено ли дело» (launch-claim), гард протухшего ввода.
 */
import { isBlindMutate } from "./error-voice.js";
import { callDrivesInput, codeResolver, type ResolveCode } from "../tools/code-input.js";
import type { DynamicToolStore } from "../tools/dynamic.js";

/** Слепое ли меняющее действие этот вызов: имя из BLIND_MUTATE или код, драйвящий ввод через SDK. */
export function isBlindMutateCall(name: string, input: unknown, resolveCode?: ResolveCode): boolean {
  return isBlindMutate(name) || callDrivesInput(name, input, resolveCode);
}

/** Резолвер кода из deps задачи: самописные инструменты — из реестра ЭТОГО владельца. */
export const loopCodeResolver = (deps: { dynamicTools?: DynamicToolStore; userId: string }): ResolveCode =>
  codeResolver(deps.dynamicTools, deps.userId);
