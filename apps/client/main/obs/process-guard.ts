/**
 * Необработанные ошибки main-процесса клиента (ревью 2026-09-24, H-L2).
 *
 * Было: ни `uncaughtException`, ни `unhandledRejection` в клиенте не ловились. Electron на исключение в
 * main показывает МОДАЛЬНЫЙ диалог и продолжает жить в неизвестном состоянии: владелец видит окно ошибки
 * (или не видит — клиент свёрнут в трей), durable-лог молчит, хранитель супервизора видит живой процесс.
 *
 * Стало:
 *  • EPIPE / закрытый поток вывода — игнор без записи в консоль (урок сервера 2026-09-02: бэкстоп, пишущий
 *    об ошибке EPIPE в тот же закрытый поток, крутил вечный цикл на 100% CPU и выедал диск);
 *  • сетевой шум сокета без обработчика (ECONNRESET/ETIMEDOUT/…) — лог, процесс живёт: транспорт сам
 *    переподключается, а перезапуск ради него стоил бы слуха на время рестарта;
 *  • прочее uncaughtException — ФАТАЛЬНО: лог, дослать хвост durable-лога, exit(1). Состояние после такого
 *    исключения не гарантировано (правило Node), а ненулевой код выхода видит хранитель и поднимает клиент
 *    с бэкоффом и алертом при серии — честнее, чем жить глухим с модальным окном;
 *  • unhandledRejection — лог (обычно это потерянный промис фоновой операции, не повреждение состояния).
 */
export type ProcessErrorVerdict = "ignore" | "log" | "fatal";

const PIPE_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]);
const NET_NOISE = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]);

function codeOf(err: unknown): string {
  const c = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return typeof c === "string" ? c : "";
}

export function classifyProcessError(kind: "uncaughtException" | "unhandledRejection", err: unknown): ProcessErrorVerdict {
  const code = codeOf(err);
  if (PIPE_CODES.has(code)) return "ignore";
  if (kind === "unhandledRejection") return "log";
  return NET_NOISE.has(code) ? "log" : "fatal";
}

export interface ProcessGuardDeps {
  on(event: "uncaughtException" | "unhandledRejection", cb: (err: unknown) => void): void;
  /** Потоки вывода: слушатель 'error' гасит асинхронный EPIPE до того, как он станет uncaughtException. */
  streams: Array<{ on(event: "error", cb: (e: unknown) => void): unknown } | undefined>;
  log: { warn(msg: string, meta?: unknown): void; error(msg: string, meta?: unknown): void };
  /** Дослать буфер durable-лога перед выходом. */
  flush(): void;
  exit(code: number): void;
}

function describe(err: unknown): { message: string; code?: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, code: codeOf(err) || undefined, stack: (err.stack ?? "").split("\n").slice(0, 6).join(" | ") };
  }
  return { message: String(err) };
}

export function installProcessGuard(d: ProcessGuardDeps): void {
  for (const s of d.streams) s?.on("error", () => {}); // закрытая труба — не наша беда, лог идёт в файл
  let exiting = false;
  const handle = (kind: "uncaughtException" | "unhandledRejection") => (err: unknown) => {
    const verdict = classifyProcessError(kind, err);
    if (verdict === "ignore") return;
    if (verdict === "log") {
      d.log.warn(`${kind} (не фатально — клиент живёт)`, describe(err));
      return;
    }
    if (exiting) return; // повторная ошибка во время выхода — не рекурсим
    exiting = true;
    d.log.error(`${kind} — фатально, выхожу с кодом 1 (хранитель супервизора поднимет клиент)`, describe(err));
    try {
      d.flush();
    } finally {
      d.exit(1);
    }
  };
  d.on("uncaughtException", handle("uncaughtException"));
  d.on("unhandledRejection", handle("unhandledRejection"));
}
