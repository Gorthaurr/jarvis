import { describe, expect, it } from "vitest";
import { browserUrlBlocked, findBlockedMcpUrl } from "./dispatch-util.js";

// §sec SSRF для MCP (аудит окружения 2026-07-21): рекурсивный скан input MCP-инструмента на URL-подобные
// значения, ведущие во внутреннюю сеть/loopback/метаданные/file:. Windows-путь НЕ URL-подобен → не задет.
describe("findBlockedMcpUrl — SSRF-скан input MCP-инструмента", () => {
  it("блокирует внутренние/loopback/metadata/file:/chrome:/data: URL в input", () => {
    expect(findBlockedMcpUrl({ url: "http://169.254.169.254/latest/meta-data" })).toContain("169.254");
    expect(findBlockedMcpUrl({ url: "http://localhost:8787/dev" })).toContain("localhost");
    expect(findBlockedMcpUrl({ url: "http://192.168.1.1/admin" })).toContain("192.168");
    expect(findBlockedMcpUrl({ path: "file:///C:/Users/anton/.ssh/id_rsa" })).toContain("file:");
    expect(findBlockedMcpUrl({ x: "chrome://settings" })).toContain("chrome:");
    expect(findBlockedMcpUrl({ x: "data:text/html,<script>" })).toContain("data:");
  });
  it("пропускает публичные http(s) URL (не SSRF)", () => {
    expect(findBlockedMcpUrl({ url: "https://api.github.com/repos/x/y" })).toBeNull();
    expect(findBlockedMcpUrl({ query: "https://www.example.com" })).toBeNull();
  });
  it("НЕ трогает Windows-путь и обычные строки (filesystem-MCP цел)", () => {
    expect(findBlockedMcpUrl({ path: "C:\\Users\\anton\\doc.txt" })).toBeNull(); // «C:\…» не URL-подобен
    expect(findBlockedMcpUrl({ text: "просто строка без схемы", n: 5 })).toBeNull();
    expect(findBlockedMcpUrl({})).toBeNull();
  });
  it("находит вложенный (объект/массив) заблокированный URL", () => {
    expect(findBlockedMcpUrl({ opts: { targets: ["https://ok.com", "http://127.0.0.1:22"] } })).toContain("127.0.0.1");
  });

  // РЕГРЕСС адверс-ревью: (1) голый хост/IP БЕЗ схемы минул гард (метадата-цель проходила); (2) свободный
  // текст с встроенным `://` (напр. think.thought) ложно блокировал весь MCP-вызов.
  it("BYPASS-фикс: голый хост/IP БЕЗ схемы ловится (169.254 / localhost / 10.x / [::1] / *.internal)", () => {
    expect(findBlockedMcpUrl({ url: "169.254.169.254/latest/meta-data" })).toContain("169.254");
    expect(findBlockedMcpUrl({ host: "localhost:8787" })).toContain("localhost");
    expect(findBlockedMcpUrl({ h: "10.0.0.1" })).toContain("10.0.0.1");
    expect(findBlockedMcpUrl({ h: "[::1]" })).toContain("::1");
    expect(findBlockedMcpUrl({ h: "db.internal:5432" })).toContain("db.internal");
  });
  it("FALSE-POSITIVE-фикс: свободный текст с встроенным URL НЕ блокирует (content-MCP цел)", () => {
    expect(findBlockedMcpUrl({ thought: "смотри https://example.com потом" })).toBeNull();
    expect(findBlockedMcpUrl({ body: "ссылки http://a.com и http://b.com в issue" })).toBeNull();
    expect(findBlockedMcpUrl({ v: "8.8.8.8" })).toBeNull(); // публичный IP-литерал — не приватный
    expect(findBlockedMcpUrl({ ver: "1.2.3.4" })).toBeNull(); // версия/публичный — второй гейт спасает
  });
});

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
