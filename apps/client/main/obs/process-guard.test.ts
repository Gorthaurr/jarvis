/**
 * Ревью 2026-09-24 (H-L2): необработанные ошибки main — фатальное завершается exit(1) (его видит хранитель),
 * шум сети и потерянные промисы — только лог, EPIPE — тишина (урок бесконечного EPIPE-цикла сервера).
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { classifyProcessError, installProcessGuard } from "./process-guard.js";

const errWith = (code: string): Error => Object.assign(new Error(code), { code });

describe("classifyProcessError", () => {
  it("EPIPE/закрытый поток — ignore; сетевой шум — log; прочее исключение — fatal; rejection — log", () => {
    expect(classifyProcessError("uncaughtException", errWith("EPIPE"))).toBe("ignore");
    expect(classifyProcessError("uncaughtException", errWith("ECONNRESET"))).toBe("log");
    expect(classifyProcessError("uncaughtException", new TypeError("x is undefined"))).toBe("fatal");
    expect(classifyProcessError("unhandledRejection", new Error("lost promise"))).toBe("log");
    expect(classifyProcessError("unhandledRejection", errWith("EPIPE"))).toBe("ignore");
  });
});

describe("installProcessGuard", () => {
  function rig() {
    const proc = new EventEmitter();
    const stdout = new EventEmitter();
    const d = {
      on: (ev: "uncaughtException" | "unhandledRejection", cb: (e: unknown) => void) => void proc.on(ev, cb),
      streams: [stdout],
      log: { warn: vi.fn(), error: vi.fn() },
      flush: vi.fn(),
      exit: vi.fn(),
    };
    installProcessGuard(d);
    return { proc, stdout, d };
  }

  it("фатальное исключение → лог + дослать durable-лог + exit(1), один раз даже при каскаде", () => {
    const { proc, d } = rig();
    proc.emit("uncaughtException", new TypeError("boom"));
    proc.emit("uncaughtException", new TypeError("boom again"));
    expect(d.log.error).toHaveBeenCalledTimes(1);
    expect(d.flush).toHaveBeenCalledTimes(1);
    expect(d.exit).toHaveBeenCalledWith(1);
    expect(d.exit).toHaveBeenCalledTimes(1);
  });

  it("потерянный промис и сетевой шум — лог, процесс живёт; EPIPE — ни лога, ни выхода", () => {
    const { proc, d } = rig();
    proc.emit("unhandledRejection", new Error("fetch failed"));
    proc.emit("uncaughtException", errWith("ECONNRESET"));
    proc.emit("uncaughtException", errWith("EPIPE"));
    expect(d.log.warn).toHaveBeenCalledTimes(2);
    expect(d.exit).not.toHaveBeenCalled();
  });

  it("ошибка потока вывода (закрытая труба) поймана слушателем — не становится uncaughtException", () => {
    const { stdout } = rig();
    expect(() => stdout.emit("error", errWith("EPIPE"))).not.toThrow(); // без слушателя emit('error') бросает
  });
});
