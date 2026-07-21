import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type McpConfig, normalizeCommand, parseMcpConfig } from "./config.js";

// На Windows голые npx/uvx через Node-spawn (без shell) дают ENOENT — нужно точное имя с расширением
// (npm-обёртки = .cmd, uv-бинари = .exe). Тест проверяет поведение для ТЕКУЩЕЙ платформы (цель — Windows).
describe("normalizeCommand — резолв команды под Node-spawn", () => {
  const win = process.platform === "win32";

  it("npx/npm → .cmd на Windows, без изменений на *nix", () => {
    expect(normalizeCommand("npx").command).toBe(win ? "npx.cmd" : "npx");
    expect(normalizeCommand("npm").command).toBe(win ? "npm.cmd" : "npm");
  });

  it("node НЕ трогает — это node.exe, а не .cmd-батник", () => {
    expect(normalizeCommand("node").command).toBe("node");
  });

  it("uvx/uv → .exe на Windows, без изменений на *nix", () => {
    expect(normalizeCommand("uvx").command).toBe(win ? "uvx.exe" : "uvx");
    expect(normalizeCommand("uv").command).toBe(win ? "uv.exe" : "uv");
  });

  it("не дублирует расширение, если оно уже есть", () => {
    expect(normalizeCommand("npx.cmd").command).toBe("npx.cmd");
    expect(normalizeCommand("uvx.exe").command).toBe("uvx.exe");
  });

  it("прочие команды (полный путь / python) не трогает", () => {
    expect(normalizeCommand("python").command).toBe("python");
    expect(normalizeCommand("C:/tools/server.exe").command).toBe("C:/tools/server.exe");
  });
});

// HTTP-транспорт для удалённых MCP (ревью learn-coding-agent 2026-07-15): url/headers + резолв ${ENV}.
describe("parseMcpConfig — HTTP-транспорт + нормализация (SRP, без файлового IO)", () => {
  let savedToken: string | undefined;
  beforeEach(() => {
    savedToken = process.env.MY_TOKEN;
    process.env.MY_TOKEN = "secret123";
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.MY_TOKEN;
    else process.env.MY_TOKEN = savedToken;
  });

  it("HTTP-сервер: url + headers с ${ENV} резолвятся, command не требуется", () => {
    const cfg: McpConfig = {
      servers: { remote: { url: "https://mcp.example.com/v1", headers: { Authorization: "Bearer ${MY_TOKEN}" } } },
    };
    const out = parseMcpConfig(cfg);
    expect(out.servers.remote).toEqual({
      url: "https://mcp.example.com/v1",
      headers: { Authorization: "Bearer secret123" },
    });
  });

  it("url имеет приоритет над command (оба заданы → HTTP, command отброшен)", () => {
    const out = parseMcpConfig({ servers: { s: { url: "http://localhost:9000", command: "npx" } } });
    expect(out.servers.s?.url).toBe("http://localhost:9000");
    expect(out.servers.s?.command).toBeUndefined();
  });

  it("невалидная схема url (file:/ftp:) → сервер пропущен, валидный рядом остаётся", () => {
    const out = parseMcpConfig({
      servers: {
        bad: { url: "file:///etc/passwd" },
        bad2: { url: "ftp://x" },
        ok: { url: "https://good.example.com" },
      },
    });
    expect(out.servers.bad).toBeUndefined();
    expect(out.servers.bad2).toBeUndefined();
    expect(out.servers.ok?.url).toBe("https://good.example.com");
  });

  it("stdio-сервер: полный путь command не трогается, args/env с ${ENV} резолвятся", () => {
    const out = parseMcpConfig({
      servers: { local: { command: "node", args: ["server.js", "${MY_TOKEN}"], env: { KEY: "${MY_TOKEN}" } } },
    });
    expect(out.servers.local?.command).toBe("node");
    expect(out.servers.local?.args).toEqual(["server.js", "secret123"]);
    expect(out.servers.local?.env).toEqual({ KEY: "secret123" });
  });

  it("ни url, ни command → сервер пропущен", () => {
    const out = parseMcpConfig({ servers: { empty: {} } });
    expect(out.servers.empty).toBeUndefined();
  });

  // §14 confirm (MCP-контракт 2026-07-21): декларация подтверждения для мутирующих MCP.
  it("confirm: true / массив bare-имён проходит; мусор отбрасывается", () => {
    const out = parseMcpConfig({
      servers: {
        all: { command: "npx", confirm: true } as never,
        some: { url: "https://x.example", confirm: ["create_issue", "delete"] } as never,
        mixed: { command: "npx", confirm: ["delete_repo", 0, "create"] } as never, // fail-open фикс: сохранить валидные
        junk: { command: "npx", confirm: "yes" } as never, // не boolean/массив-строк → поля нет
        none: { command: "npx" },
      },
    });
    expect(out.servers.all?.confirm).toBe(true);
    expect(out.servers.some?.confirm).toEqual(["create_issue", "delete"]);
    expect(out.servers.mixed?.confirm).toEqual(["delete_repo", "create"]); // мусор 0 отброшен, delete_repo цел
    expect(out.servers.junk?.confirm).toBeUndefined();
    expect(out.servers.none?.confirm).toBeUndefined();
  });
});
