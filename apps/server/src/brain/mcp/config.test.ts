import { describe, expect, it } from "vitest";
import { normalizeCommand } from "./config.js";

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
