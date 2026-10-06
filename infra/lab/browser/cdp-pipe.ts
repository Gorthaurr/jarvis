/**
 * CDP поверх --remote-debugging-pipe: fd3 — В Chrome, fd4 — ИЗ Chrome, сообщения JSON, оканчивающиеся нулевым байтом.
 * Труба, а не TCP-порт: у отладки нет порта, к которому мог бы подключиться кто-то ещё на ПК (эфемерный порт тоже
 * порт), а закрытие трубы гасит сам браузер — сирота не переживёт родителя.
 */
import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface CdpReply {
  id?: number;
  result?: Record<string, any>;
  error?: { message: string; code?: number };
  method?: string;
  params?: Record<string, any>;
  sessionId?: string;
}

export interface CdpPipe {
  /** Вызов метода CDP. Нет ответа за таймаут → { error }, а не вечное ожидание (Chrome завис/упал). */
  send(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<CdpReply>;
  /** Закрыть трубу (Chrome завершится сам). */
  end(): void;
}

/** Труба к процессу, запущенному с stdio [ignore, ignore, ignore, "pipe", "pipe"]. */
export function pipeCdp(proc: ChildProcess): CdpPipe {
  const toChrome = proc.stdio[3] as Writable | null;
  const fromChrome = proc.stdio[4] as Readable | null;
  if (!toChrome || !fromChrome) throw new Error("у процесса нет каналов fd3/fd4 (--remote-debugging-pipe)");
  const pending = new Map<number, (m: CdpReply) => void>();
  let seq = 0;
  // Буфер БАЙТОВ, а не строка: чанк может разрезать кириллицу посреди символа (подписи кнопок сравниваются дословно).
  let buf = Buffer.alloc(0);
  fromChrome.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (let i = buf.indexOf(0); i >= 0; i = buf.indexOf(0)) {
      const m = JSON.parse(buf.subarray(0, i).toString("utf8")) as CdpReply;
      buf = buf.subarray(i + 1);
      const done = m.id !== undefined ? pending.get(m.id) : undefined;
      if (m.id !== undefined && done) {
        pending.delete(m.id);
        done(m);
      }
    }
  });
  // Chrome умер: ждущие вызовы получают ошибку сразу, а не через 15 с.
  const failAll = (): void => {
    for (const [id, done] of pending) done({ id, error: { message: "Chrome закрыл трубу отладки" } });
    pending.clear();
  };
  fromChrome.on("close", failAll);
  toChrome.on("error", failAll);
  return {
    send: (method, params = {}, sessionId, timeoutMs = 15_000) =>
      new Promise((resolve) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ id, error: { message: `CDP ${method}: нет ответа ${timeoutMs / 1000} с` } });
        }, timeoutMs);
        pending.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        toChrome.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`, (e) => e && failAll());
      }),
    end() {
      try {
        toChrome.end();
        fromChrome.destroy();
      } catch {
        /* уже закрыта */
      }
    },
  };
}
