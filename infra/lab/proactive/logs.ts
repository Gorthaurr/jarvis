/**
 * Перехват консольных логов продукта на время прогона стенда: тесты не тонут в шуме, а строки лога доступны для проверок
 * («лог не врёт»: не пишет «озвучено», когда не озвучено). LAB_VERBOSE=1 - печатать как обычно.
 */
import { inspect } from "node:util";

export interface LogCapture {
  lines: string[];
  restore(): void;
}

export function captureLogs(): LogCapture {
  const lines: string[] = [];
  if (process.env.LAB_VERBOSE === "1") return { lines, restore() {} };
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const push = (...a: unknown[]): void => {
    lines.push(a.map((x) => (typeof x === "string" ? x : inspect(x, { breakLength: Number.POSITIVE_INFINITY }))).join(" "));
  };
  console.log = push;
  console.warn = push;
  console.error = push;
  return {
    lines,
    restore() {
      console.log = saved.log;
      console.warn = saved.warn;
      console.error = saved.error;
    },
  };
}
