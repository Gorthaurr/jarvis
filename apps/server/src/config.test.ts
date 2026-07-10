import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig — host bind (универсальность/безопасность)", () => {
  afterEach(() => {
    delete process.env.HOST;
  });

  it("по умолчанию ТОЛЬКО loopback 127.0.0.1 (НЕ 0.0.0.0 — иначе LAN-сосед без auth исполняет команды)", () => {
    delete process.env.HOST;
    expect(loadConfig().host).toBe("127.0.0.1");
  });

  it("HOST env переопределяет (мульти-девайс — но ТОЛЬКО вместе с auth, Фаза 6B)", () => {
    process.env.HOST = "0.0.0.0";
    expect(loadConfig().host).toBe("0.0.0.0");
  });
});
