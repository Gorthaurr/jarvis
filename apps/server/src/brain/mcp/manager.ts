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
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Logger, createLogger } from "@jarvis/shared";
import type { ToolSchema } from "@jarvis/tools";
import type { McpConfig, McpServerConfig } from "./config.js";

/** Транспорт MCP-клиента: локальный stdio (спавнит ребёнка) ИЛИ удалённый StreamableHTTP (без ребёнка). */
type McpTransport = StdioClientTransport | StreamableHTTPClientTransport;

interface ServerEntry {
  client: Client;
  transport?: McpTransport; // §L6: держим ссылку → force-kill дерева ребёнка на dispose (для stdio; http — no-op)
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

/** Форс-килл дерева дочернего процесса транспорта по PID (§L6; аудит-2 [1]/[2] — независимо от close).
 *  Для HTTP-транспорта pid отсутствует → ранний выход (нечего убивать). */
function killTransportTree(transport: McpTransport | undefined): void {
  const pid = (transport as { pid?: number | null } | undefined)?.pid ?? undefined;
  if (typeof pid !== "number" || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
    } else {
      try {
        process.kill(-pid, "SIGKILL"); // группа npx→node
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* процесс уже мёртв / нет прав — не критично */
  }
}

export class McpManager {
  private readonly servers = new Map<string, ServerEntry>();
  /** namespaced имя → { server, bare } для O(1) роутинга callTool. */
  private readonly index = new Map<string, { server: string; bare: string }>();
  private readonly log: Logger;
  /** Аудит-2 [1]: dispose() уже прошёл — connectOne, дорезолвившийся ПОСЛЕ, обязан убить свой свежий
   *  transport и НЕ заселять servers (иначе живой stdio-ребёнок остаётся сиротой мимо taskkill). */
  private disposed = false;

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
    let transport: McpTransport | undefined;
    try {
      const client = new Client({ name: "jarvis", version: "1.0.0" }, { capabilities: {} });
      if (sc.url) {
        // HTTP-транспорт (удалённый/SaaS MCP): секреты — статический Bearer в sc.headers (${ENV} уже резолвнут
        // в config). Без OAuth-flow (тяжёл и неуместен на headless single-user сервере — см. CLAUDE.md).
        const headers = sc.headers ?? {};
        transport = new StreamableHTTPClientTransport(new URL(sc.url), {
          ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
        });
      } else {
        const command = sc.command;
        if (!command) throw new Error("MCP-сервер без command и без url — нечего запускать");
        transport = new StdioClientTransport({
          command,
          args: sc.args ?? [],
          // §sec (H15): базовый allowlist + ТОЛЬКО объявленный sc.env — не разворачиваем весь process.env
          // (иначе все секреты сервера утекают каждому MCP-ребёнку). github-MCP получит свой PAT через sc.env.
          env: { ...baseChildEnv(), ...(sc.env ?? {}) },
        });
      }
      await client.connect(transport);
      // Аудит-2 [1]: пока мы коннектились (~2.3с), мог пройти dispose() → servers уже вычищен и никто не
      // убьёт этого ребёнка. Убиваем свой свежий transport и НЕ заселяем реестр (иначе процесс-сирота).
      if (this.disposed) {
        killTransportTree(transport);
        try {
          await client.close();
        } catch {
          /* ignore */
        }
        return;
      }
      const listed = await client.listTools();
      const tools: ToolSchema[] = [];
      for (const t of listed.tools ?? []) {
        const ns = `mcp__${san(name)}__${san(t.name)}`;
        if (this.reserved.has(ns) || this.index.has(ns)) continue; // не затеняем нативные/дубли
        this.index.set(ns, { server: name, bare: t.name });
        tools.push({ name: ns, description: `[MCP:${name}] ${t.description ?? t.name}`, input_schema: normSchema(t.inputSchema) });
      }
      if (this.disposed) {
        killTransportTree(transport); // повторная проверка после второго await (listTools)
        try {
          await client.close();
        } catch {
          /* ignore */
        }
        return;
      }
      this.servers.set(name, { client, transport, tools, state: "connected" });
      this.log.info("MCP сервер подключён", { server: name, tools: tools.length });
    } catch (e) {
      if (this.disposed) {
        killTransportTree(transport); // dispose прошёл во время неудачного connect — не оставляем сироту
        return;
      }
      // transport мог уже спавнить ребёнка до провала connect — сохраняем для kill в dispose.
      this.servers.set(name, { client: null as unknown as Client, transport, tools: [], state: "error" });
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
    this.disposed = true; // [1]: connectOne, дорезолвившийся после этого, сам убьёт свой transport
    const entries = [...this.servers.values()];
    // Аудит-2 [2]: force-kill ВСЕХ детей по PID СРАЗУ (не за последовательным await close). §L6:
    // client.close() на Windows НЕ убивает дерево npx/node; а зависший close() ОДНОГО мёртвого stdio-child
    // раньше блокировал taskkill остальных → при 2с-обрезке dispose (server.ts) их деревья оставались
    // зомби. Kill по PID (fire-and-forget, unref) не зависит от close.
    for (const e of entries) killTransportTree(e.transport);
    // Затем best-effort graceful close ПАРАЛЛЕЛЬНО (не блокирует друг друга).
    await Promise.allSettled(entries.map((e) => e.client?.close?.()));
    this.servers.clear();
    this.index.clear();
  }
}
