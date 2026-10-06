/** Общие константы и мелочи для файлов сценариев: пути виртуального ПК, бюджеты, вызов эталона. */
import type { ConfirmPolicy } from "../lib/contracts.js";
import type { OracleCall } from "./types.js";

/** Домашняя папка виртуального ПК (FakeDesktop): мозг её не знает и находит сам (`%USERPROFILE%`, `~`, листинг). */
export const HOME = "C:/Users/lab";
export const DESK = `${HOME}/Desktop`;
export const DOCS = `${HOME}/Documents`;
export const DOWN = `${HOME}/Downloads`;

/** Настоящий мозг: кап задачи на сервере 240 с (×2 при подписке) — короче бюджет нельзя, иначе обрежем честный ответ. */
export const REAL_BUDGET = { maxMs: 240_000, maxActions: 40 } as const;
/** tier0 ($0): ответ за секунды. */
export const FAST_BUDGET = { maxMs: 30_000, maxActions: 6 } as const;

export const call = (tool: string, args: Record<string, unknown>, confirm?: ConfirmPolicy): OracleCall => ({ tool, args, ...(confirm !== undefined ? { confirm } : {}) });

/** Проверка сценария «только живьём»: раннер такие не запускает, а если запустят вручную — не выдаст зелёное. */
export const liveOnlyCheck = (): { pass: false; why: string } => ({ pass: false, why: "сценарий liveOnly: без владельца/железа ничего не доказывает" });
