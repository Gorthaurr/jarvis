/** Codex работает только через вход ChatGPT; все действия ПК остаются в Jarvis. */
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function codexBinary(): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const root = join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    try {
      const binaries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
        .map((e) => join(root, e.name, "codex.exe")).filter(existsSync);
      binaries.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (binaries[0]) return binaries[0];
    } catch { /* обычная установка CLI через PATH */ }
  }
  return "codex";
}

export function codexProcessConfig() {
  const args = ["app-server", "--listen", "stdio://"];
  const overrides: Record<string, unknown> = {
    model_provider: "openai", forced_login_method: "chatgpt", web_search: "disabled",
    mcp_servers: {}, plugins: {}, notify: [], approval_policy: "never", sandbox_mode: "read-only",
  };
  for (const feature of ["shell_tool", "unified_exec", "apps", "plugins", "hooks", "memories",
    "multi_agent", "browser_use", "computer_use", "image_generation", "view_image", "goals", "in_app_browser"]) {
    overrides[`features.${feature}`] = false;
  }
  // code_mode_host нужен для dynamicTools даже при отключённых исполнителях ОС.
  overrides["features.code_mode_host"] = true;
  for (const [key, value] of Object.entries(overrides)) args.push("-c", `${key}=${JSON.stringify(value)}`);
  const env = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"]) delete env[key];
  return { command: codexBinary(), args, env,
    cwd: mkdtempSync(join(tmpdir(), "jarvis-codex-")) };
}
