/**
 * McpManager — Джарвис как MCP-host (§ арсенал). Подключает MCP-серверы (config mcp.json), забирает их
 * инструменты и отдаёт мозгу: имена в ХОЛОДНЫЙ каталог (ленивая загрузка §15), исполнение — callTool.
 *
 * Принципы (по docs/MCP_PLAN.md, сверено с воркфлоу):
 *  - неймспейс `mcp__<server>__<tool>` (санитайз к [A-Za-z0-9_-]{1,64}) — не пересекается с нативными;
 *  - НЕ блокирует boot: connectAll fire-and-forget, сбой сервера не валит остальные (allSettled);
 *  - MCP-инструменты — ХОЛОДНЫЕ: схемы не шлём каждый ход, только каталог; dispatch роутит по callTool;
 *  - честность по ошибкам: callTool ловит сбой → isError (петля переживёт), не throw наружу.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type Logger, createLogger } from "@jarvis/shared";
import type { ToolSchema } from "@jarvis/tools";
import type { McpConfig, McpServerConfig } from "./config.js";

interface ServerEntry {
  client: Client;
  tools: ToolSchema[]; // уже в namespaced-виде (имя = mcp__server__tool)
  state: "connected" | "error";
}

/** Санитайз имени под лимит Anthropic [A-Za-z0-9_-]{1,64}. */
function san(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "x";
}

/** MCP inputSchema → валидный Anthropic input_schema (защита от кривых сторонних схем). */
function normSchema(raw: unknown): ToolSchema["input_schema"] {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    type: "object",
    properties: (s.properties as Record<string, unknown>) ?? {},
    ...(Array.isArray(s.required) ? { required: s.required as string[] } : {}),
  } as ToolSchema["input_schema"];
}

/**
 * §sec (H15) ALLOWLIST env для дочерних MCP-процессов. Раньше детям отдавали ВЕСЬ process.env —
 * сервер `think` без объявленного env всё равно получал CREDENTIALS_MASTER_KEY, DATABASE_URL,
 * ANTHROPIC_API_KEY, GitHub PAT (один скомпрометированный/тайпсквоттинг-MCP читал бы все секреты).
 * Теперь ребёнку даём только базовый набор для запуска + ЯВНО объявленный в mcp.json sc.env.
 */
const SAFE_ENV_KEYS: readonly string[] = [
  "PATH", "Path", "SystemRoot", "windir", "SystemDrive", "HOMEDRIVE", "HOMEPATH", "USERPROFILE", "HOME",
  "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
  "TEMP", "TMP", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS", "OS", "LANG", "LC_ALL", "TZ",
];
function baseChildEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SAFE_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export class McpManager {
  private readonly servers = new Map<string, ServerEntry>();
  /** namespaced имя → { server, bare } для O(1) роутинга callTool. */
  private readonly index = new Map<string, { server: string; bare: string }>();
  private readonly log: Logger;

  constructor(
    private readonly reserved: ReadonlySet<string>,
    private readonly cfg: McpConfig,
    log: Logger = createLogger("mcp"),
  ) {
    this.log = log;
  }

  /** Подключить все серверы из конфига. НЕ блокирует boot (вызывать без await перед app.listen). */
  async connectAll(): Promise<void> {
    const entries = Object.entries(this.cfg.servers ?? {});
    if (entries.length === 0) {
      this.log.info("MCP: серверов в конфиге нет (mcp.json пуст/отсутствует) — арсенал пуст");
      return;
    }
    await Promise.allSettled(entries.map(([name, sc]) => this.connectOne(name, sc)));
    this.log.info("MCP: подключение завершено", { серверов: this.servers.size, инструментов: this.index.size });
  }

  private async connectOne(name: string, sc: McpServerConfig): Promise<void> {
    try {
      const client = new Client({ name: "jarvis", version: "1.0.0" }, { capabilities: {} });
      const transport = new StdioClientTransport({
        command: sc.command,
        args: sc.args ?? [],
        // §sec (H15): базовый allowlist + ТОЛЬКО объявленный sc.env — не разворачиваем весь process.env
        // (иначе все секреты сервера утекают каждому MCP-ребёнку). github-MCP получит свой PAT через sc.env.
        env: { ...baseChildEnv(), ...(sc.env ?? {}) },
      });
      await client.connect(transport);
      const listed = await client.listTools();
      const tools: ToolSchema[] = [];
      for (const t of listed.tools ?? []) {
        const ns = `mcp__${san(name)}__${san(t.name)}`;
        if (this.reserved.has(ns) || this.index.has(ns)) continue; // не затеняем нативные/дубли
        this.index.set(ns, { server: name, bare: t.name });
        tools.push({ name: ns, description: `[MCP:${name}] ${t.description ?? t.name}`, input_schema: normSchema(t.inputSchema) });
      }
      this.servers.set(name, { client, tools, state: "connected" });
      this.log.info("MCP сервер подключён", { server: name, tools: tools.length });
    } catch (e) {
      this.servers.set(name, { client: null as unknown as Client, tools: [], state: "error" });
      this.log.warn("MCP сервер не подключился", { server: name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  get connected(): boolean {
    return this.index.size > 0;
  }

  has(name: string): boolean {
    return this.index.has(name);
  }

  /** Все MCP-инструменты в формате Anthropic (для активированных через tool_load). */
  asToolSchemas(): ToolSchema[] {
    const out: ToolSchema[] = [];
    for (const e of this.servers.values()) out.push(...e.tools);
    return out;
  }

  /** Исполнить MCP-инструмент по namespaced-имени. Ошибка → {isError:true}, не throw (честность §). */
  async callTool(name: string, input: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    const ref = this.index.get(name);
    if (!ref) return { content: `MCP-инструмент ${name} не найден`, isError: true };
    const entry = this.servers.get(ref.server);
    if (!entry || entry.state !== "connected") return { content: `MCP-сервер ${ref.server} недоступен`, isError: true };
    try {
      const res = (await entry.client.callTool({ name: ref.bare, arguments: input })) as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
      };
      const text = (res.content ?? [])
        .map((c) => (c.type === "text" ? c.text : c.type ? `[${c.type}]` : ""))
        .filter(Boolean)
        .join("\n")
        .slice(0, 8000);
      return { content: text || "ok", isError: Boolean(res.isError) };
    } catch (e) {
      return { content: `Ошибка MCP ${name}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  }

  status(): Array<{ server: string; state: string; tools: number }> {
    return [...this.servers.entries()].map(([server, e]) => ({ server, state: e.state, tools: e.tools.length }));
  }

  async dispose(): Promise<void> {
    for (const e of this.servers.values()) {
      try {
        await e.client?.close?.();
      } catch {
        /* ignore */
      }
    }
    this.servers.clear();
    this.index.clear();
  }
}
