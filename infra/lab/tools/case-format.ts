/**
 * Формат КЕЙСА инструмента лаборатории: «вызвали инструмент с такими аргументами на таком рабочем столе → ожидаем такое
 * по ФАКТУ» (результат, честные флаги, вопросы §14, ушедшие клиенту команды, эффекты и итоговое состояние «ПК»).
 * Кейсы — данные: их пишут по всем ~112 схемам (docs: tools/cases/README.md).
 */
import type { ConfirmPolicy, DesktopEffect, DesktopSeed, DesktopSnapshot } from "../lib/contracts.js";
import type { ToolLabOptions } from "./harness.js";

/** Декларативный предикат по журналу эффектов. */
export type EffectCheck =
  /** Был эффект вида `has`; `detail` — подмножество его полей (глубоко); `count` — сколько таких (по умолчанию ≥ 1). */
  | { has: string; detail?: Record<string, unknown>; count?: number }
  /** Эффектов вида `none` НЕ было (защита: «отказали — значит ничего не трогали»). */
  | { none: string }
  /** Произвольный предикат: true — ок; строка — причина провала. */
  | ((effects: DesktopEffect[], snapshot: DesktopSnapshot) => boolean | string);

export type HonestyFlag = "sent" | "declined" | "uncertain" | "observed" | "empty" | "channelDown" | "overlayDenied" | "veiled";

export interface ToolExpect {
  /** true — инструмент отработал (не isError); false — честная ошибка. */
  ok?: boolean;
  /** Текст tool_result содержит ВСЕ подстроки/совпадает со всеми регулярками. */
  resultIncludes?: Array<string | RegExp> | string | RegExp;
  /** Текст НЕ содержит ни одной из подстрок (напр. ложное «Готово»). */
  resultExcludes?: Array<string | RegExp> | string | RegExp;
  /** Флаги честности ToolResult: true — выставлен, false — НЕ выставлен. Не названные не проверяются. */
  flags?: Partial<Record<HonestyFlag, boolean>>;
  /** ТОЧНАЯ последовательность видов ActionCommand, что ушли клиенту (`[]` — не ушло ничего). */
  actionKinds?: string[];
  /** Сколько §14-вопросов задано владельцу. */
  asked?: number;
  /** Предикаты по эффектам на «ПК» за вызов. */
  effects?: EffectCheck[];
  /** Предикат по итоговому состоянию «ПК»: true — ок; строка — причина провала. */
  state?: (snapshot: DesktopSnapshot) => boolean | string;
  /** Инструмент честно НЕ проверяется в лаборатории (причина — подстрока/регулярка). */
  notVerifiable?: string | RegExp;
}

export interface CaseStep {
  tool: string;
  args?: Record<string, unknown>;
  confirm?: ConfirmPolicy;
}

export interface ToolCase {
  /** Инструмент, как его зовёт модель (может быть фасад look/window/audio). */
  tool: string;
  /** Короткое имя сценария: «отказ владельца», «файл записан». */
  name: string;
  args?: Record<string, unknown>;
  /** Начальное состояние «ПК» (по умолчанию — типовой рабочий стол FakeDesktop). */
  seed?: DesktopSeed;
  /** Политика ответов на §14 для основного вызова (по умолчанию "no"). */
  confirm?: ConfirmPolicy;
  /** Предусловия: вызовы ДО основного (должны пройти без ошибки). Их эффекты в проверку не входят. */
  before?: CaseStep[];
  /** Части ToolContext/DNS для этого кейса (мок ext, market...). */
  lab?: Pick<ToolLabOptions, "ctx" | "dns">;
  expect: ToolExpect;
  /** Какой КАНОНИЧЕСКИЙ инструмент кейс доказывает (для матрицы покрытия; `look{windows}` → "window_list"). */
  coversTool: string;
  /**
   * Виды команд FakeDesktop, без которых кейс бессмыслен. Не заданы — берутся из expect.actionKinds и `before`.
   * Не поддержанный FakeDesktop вид → кейс пропускается с причиной (и оживает сам, когда обработчик появится).
   */
  needsKinds?: string[];
  /** Ручной пропуск с причиной (не засчитывается в покрытие). */
  skip?: string;
}

export const caseId = (c: Pick<ToolCase, "tool" | "name">): string => `${c.tool}: ${c.name}`;
