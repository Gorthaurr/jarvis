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

import { McpManager, normalizeMcpImages } from "./manager.js";

// Ревью MCP-контракта: image-нормализация под Anthropic (allowlist/data-URI/размер/кап) — иначе сторонний
// mimeType (svg/bmp) или data-URI-префикс → HTTP 400 на ВЕСЬ ход. Чистая функция → юнит напрямую.
describe("normalizeMcpImages — нормализация image-блоков MCP под Anthropic", () => {
  it("поддерживаемые mime проходят; отсутствующий → png", () => {
    const r = normalizeMcpImages([
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      { type: "image", data: "BBBB" }, // нет mime → png
      { type: "text" }, // не картинка — фильтр пропустит
    ]);
    expect(r.images).toEqual([
      { mediaType: "image/jpeg", data: "AAAA" },
      { mediaType: "image/png", data: "BBBB" },
    ]);
    expect(r.dropped).toBe(0);
  });
  it("неподдерживаемый mime (svg/bmp) ДРОПАЕТСЯ (не роняем ход), считается в dropped", () => {
    const r = normalizeMcpImages([
      { type: "image", data: "SVG", mimeType: "image/svg+xml" },
      { type: "image", data: "BMP", mimeType: "image/bmp" },
      { type: "image", data: "OK", mimeType: "image/webp" },
    ]);
    expect(r.images).toEqual([{ mediaType: "image/webp", data: "OK" }]);
    expect(r.dropped).toBe(2);
  });
  it("data-URI-префикс срезается, mime извлекается из него", () => {
    const r = normalizeMcpImages([{ type: "image", data: "data:image/gif;base64,R0lGOD", mimeType: "" }]);
    expect(r.images).toEqual([{ mediaType: "image/gif", data: "R0lGOD" }]);
  });
  it("ревью-2: пустой payload после срезки data-URI ДРОПАЕТСЯ (пустой base64 → 400)", () => {
    const r = normalizeMcpImages([{ type: "image", data: "data:image/png;base64," }]); // тело пустое
    expect(r.images).toHaveLength(0);
    expect(r.dropped).toBe(1); // честно посчитан
  });
  it("кап 4 (лишние в dropped) и size-guard >~3.75MB", () => {
    const many = Array.from({ length: 6 }, () => ({ type: "image", data: "x", mimeType: "image/png" }));
    const r = normalizeMcpImages(many);
    expect(r.images).toHaveLength(4);
    expect(r.dropped).toBe(2);
    const big = normalizeMcpImages([{ type: "image", data: "y".repeat(5_000_001), mimeType: "image/png" }]);
    expect(big.images).toHaveLength(0);
    expect(big.dropped).toBe(1);
  });
});

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
