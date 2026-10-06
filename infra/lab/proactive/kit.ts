/**
 * Инструментарий ДОКАЗАТЕЛЬСТВА не-декоративности тестов проактива (без правки продукта).
 *   LAB_FLIP=all|N  - `expect` из этого модуля переворачивает ожидание на противоположное: all - каждое, N - только N-е по счёту
 *                     в тесте. Честный тест краснеет; зелёный под флипом при N <= числа ожиданий = ожидание ничего не проверяло.
 *   LAB_FAULT=...   - честная неисправность СЦЕНАРИЯ (не продукта): noadvance (часы стоят), deaf (TTS не звучит),
 *                     ownerless (сессия не подключена к сервисам), amnesia (рестарт теряет диск).
 *   LAB_DEFECTS=1   - снять skip с кейсов "ДЕФЕКТ: ..." и убедиться, что они КРАСНЫЕ на текущем продукте.
 * Число ожиданий каждого теста печатается строкой `FLIPCOUNT<TAB>имя<TAB>N` (её читает prove.mjs).
 */
import { afterEach, expect as realExpect } from "vitest";

const RAW_FLIP = process.env.LAB_FLIP ?? "";
export const FLIP = RAW_FLIP !== "";
export const FAULT = process.env.LAB_FAULT ?? "";
export const DEFECTS = process.env.LAB_DEFECTS === "1";

type Matchers = Record<string, unknown>;

/** Цепочка матчеров с инверсией: `neg` = «использовать .not». Собственный `.not` переключает инверсию обратно. */
function chain(m: Matchers, neg: boolean): Matchers {
  return new Proxy(m, {
    get(target, prop) {
      if (prop === "not") return chain(target, !neg);
      const src = (neg ? target.not : target) as Matchers;
      const v = src[prop as string];
      // Не bind(): chai-прокси матчера бросает на чтении .length/.name функции (это ложный «красный» без единого assert).
      return typeof v === "function" ? (...a: unknown[]) => Reflect.apply(v as (...x: unknown[]) => unknown, src, a) : v;
    },
  });
}

let seen = 0;

function flipped(base: typeof realExpect): typeof realExpect {
  const wrap = ((value: unknown, message?: string) => {
    seen += 1;
    const m = base(value, message) as unknown as Matchers;
    return RAW_FLIP === "all" || Number(RAW_FLIP) === seen ? chain(m, true) : m;
  }) as unknown as typeof realExpect;
  return Object.assign(wrap, base);
}

if (FLIP) {
  afterEach((ctx) => {
    console.log(`FLIPCOUNT\t${ctx.task.name}\t${seen}`);
    seen = 0;
  });
}

export const expect: typeof realExpect = FLIP ? flipped(realExpect) : realExpect;
