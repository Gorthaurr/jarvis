/**
 * Аудит ядра 2-й проход [1]/[2]: жизненный цикл MCP-детей без зомби.
 * [1] connectOne, дорезолвившийся ПОСЛЕ dispose(), НЕ заселяет реестр (иначе живой stdio-ребёнок — сирота).
 * [2] dispose() убивает деревья ВСЕХ детей по PID независимо от того, завис/упал ли close() соседа.
 * MCP-SDK замокан (реальный тянет stdio-процессы). Проверяем логику менеджера, не сам транспорт.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Контролируемые деферы коннекта + счётчик убитых транспортов.
const killed: number[] = [];
let connectGate: Promise<void> = Promise.resolve();

const spawnMock = vi.fn(() => ({ unref: () => undefined }));
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[]) => {
    if (cmd === "taskkill") killed.push(Number(args[1])); // args = ["/PID", "<pid>", "/T", "/F"]
    return spawnMock();
  },
}));

let pidSeq = 1000;
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    pid: number;
    constructor() {
      this.pid = ++pidSeq;
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect(): Promise<void> {
      await connectGate; // тест управляет моментом резолва коннекта
    }
    async listTools(): Promise<{ tools: unknown[] }> {
      return { tools: [] };
    }
    async close(): Promise<void> {
      /* graceful no-op */
    }
  },
}));

import { McpManager } from "./manager.js";

function mgr(servers: Record<string, { command: string; args?: string[] }>): McpManager {
  return new McpManager(new Set<string>(), { servers } as never);
}

beforeEach(() => {
  killed.length = 0;
  pidSeq = 1000;
  connectGate = Promise.resolve();
});
afterEach(() => vi.clearAllMocks());

describe("McpManager — жизненный цикл детей (аудит-2 [1]/[2])", () => {
  it("[1] dispose ПОСРЕДИ connect → сервер НЕ заселён, свежий transport убит (не сирота)", async () => {
    let releaseConnect!: () => void;
    connectGate = new Promise<void>((r) => {
      releaseConnect = r;
    });
    const m = mgr({ think: { command: "npx", args: ["-y", "x"] } });
    const connectAll = m.connectAll(); // await client.connect висит на connectGate
    await m.dispose(); // dispose проходит ПОКА коннект не завершён
    releaseConnect(); // теперь connect резолвится
    await connectAll;
    // сервер НЕ должен попасть в реестр (disposed-гард), а его transport — убит по PID
    expect(m.status()).toHaveLength(0);
    expect(m.connected).toBe(false);
    expect(killed.length).toBeGreaterThanOrEqual(1);
  });

  it("[2] dispose убивает деревья ВСЕХ детей по PID (не блокируется close соседа)", async () => {
    const m = mgr({
      a: { command: "npx", args: ["a"] },
      b: { command: "npx", args: ["b"] },
    });
    await m.connectAll(); // оба подключились (connectGate резолвлен)
    expect(m.status()).toHaveLength(2);
    killed.length = 0;
    await m.dispose();
    // оба PID переданы в taskkill — kill не за последовательным await close
    expect(killed.length).toBe(2);
    expect(m.status()).toHaveLength(0);
  });
});
