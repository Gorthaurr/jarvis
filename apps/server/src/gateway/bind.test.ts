import { describe, expect, it, vi } from "vitest";
import type { Logger } from "@jarvis/shared";
import { isLoopbackHost, resolveBindHost } from "./bind.js";

function capturingLog(): Logger {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  (l as { child: (s: string) => Logger }).child = () => l;
  return l;
}

type Cfg = { host: string; allowRemote: boolean; authStrict: boolean };

describe("bind-гард (§6B/безопасность)", () => {
  it("isLoopbackHost: loopback варианты true, остальное false", () => {
    for (const h of ["127.0.0.1", "::1", "localhost", "", "  LOCALHOST  "]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "192.168.1.10", "10.0.0.5", "example.com"]) expect(isLoopbackHost(h)).toBe(false);
  });

  it("loopback host → отдаём как есть, без логов", () => {
    const log = capturingLog();
    const cfg: Cfg = { host: "127.0.0.1", allowRemote: false, authStrict: false };
    expect(resolveBindHost(cfg, log)).toBe("127.0.0.1");
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("пустой/пробельный host (в Node = bind-all) нормализуется в 127.0.0.1, wildcard не отдаём", () => {
    const log = capturingLog();
    for (const h of ["", "   "]) {
      expect(resolveBindHost({ host: h, allowRemote: false, authStrict: false }, log)).toBe("127.0.0.1");
    }
    expect(log.error).not.toHaveBeenCalled();
  });

  it("не-loopback БЕЗ JARVIS_ALLOW_REMOTE → принудительно 127.0.0.1 + error (сервер не падает)", () => {
    const log = capturingLog();
    const cfg: Cfg = { host: "0.0.0.0", allowRemote: false, authStrict: false };
    expect(resolveBindHost(cfg, log)).toBe("127.0.0.1");
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("§sec FAIL-CLOSED: не-loopback + ALLOW_REMOTE, но без AUTH_STRICT → принудительно 127.0.0.1 + error (H8)", () => {
    const log = capturingLog();
    const cfg: Cfg = { host: "0.0.0.0", allowRemote: true, authStrict: false };
    expect(resolveBindHost(cfg, log)).toBe("127.0.0.1"); // remote БЕЗ strict-auth НЕ выпускаем наружу
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("не-loopback + ALLOW_REMOTE + AUTH_STRICT → слушаем host, без предупреждений", () => {
    const log = capturingLog();
    const cfg: Cfg = { host: "192.168.1.50", allowRemote: true, authStrict: true };
    expect(resolveBindHost(cfg, log)).toBe("192.168.1.50");
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
