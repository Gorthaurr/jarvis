import { describe, expect, it } from "vitest";
import { browserUrlBlocked } from "./dispatch-util.js";

// § C1 (CRITICAL, SSRF fail-open): голый хост без схемы ("169.254.169.254", "localhost", "127.0.0.1")
// валит `new URL(raw)` — раньше это трактовалось как "не URL, не SSRF-кейс" и ВОЗВРАЩАЛО false (пропуск
// гейта). Фикс нормализует отсутствующую схему на https:// и прогоняет те же приватные/loopback/
// link-local/metadata-проверки, что isFetchUrlAllowed (§14).
describe("browserUrlBlocked — SSRF-гард на голых хостах без схемы (C1)", () => {
  it("блокирует cloud-metadata IP без схемы", () => {
    expect(browserUrlBlocked("169.254.169.254")).toBe(true);
  });

  it("блокирует localhost без схемы", () => {
    expect(browserUrlBlocked("localhost")).toBe(true);
  });

  it("блокирует loopback IP без схемы", () => {
    expect(browserUrlBlocked("127.0.0.1")).toBe(true);
  });

  it("блокирует приватную сеть (RFC1918) без схемы", () => {
    expect(browserUrlBlocked("192.168.1.1")).toBe(true);
  });

  it("пропускает публичный голый хост (резолвится в обычный сайт)", () => {
    expect(browserUrlBlocked("example.com")).toBe(false);
  });

  it("пропускает публичный URL со схемой", () => {
    expect(browserUrlBlocked("https://example.com/page")).toBe(false);
  });

  it("блокирует file:/chrome: схемы как раньше", () => {
    expect(browserUrlBlocked("file:///C:/secret.txt")).toBe(true);
    expect(browserUrlBlocked("chrome://settings")).toBe(true);
  });

  it("блокирует мусор, не парсящийся даже с https:// префиксом", () => {
    expect(browserUrlBlocked("::::not a host::::")).toBe(true);
  });
});
