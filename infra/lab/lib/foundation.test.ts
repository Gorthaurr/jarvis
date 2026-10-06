/**
 * Дымовой тест фундамента лаборатории: инструментальная цепочка работает БЕЗ pnpm install и без вмешательства в node_modules.
 * Если это красное — строить лабораторию не на чем.
 */
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, makeEnvelope } from "@jarvis/protocol";
import { AudioCoordinator } from "../../../apps/client/main/audio/index.js";
import { isWakeAddressedStrict } from "../../../apps/server/src/voice/wake-strict.js";
import { WebSocket, repoRoot } from "./deps.js";
import type { LabServer } from "./contracts.js";

describe("фундамент лаборатории", () => {
  it("протокол доступен через алиас @jarvis/protocol", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(makeEnvelope("pong", {}).type).toBe("pong");
  });

  it("ws берётся от клиента без установки зависимостей", () => {
    expect(typeof WebSocket).toBe("function");
    expect(repoRoot("apps/server").endsWith("/jarvis/apps/server")).toBe(true);
  });

  it("исходники сервера и клиента импортируются относительными путями, их bare-импорты резолвятся", () => {
    expect(isWakeAddressedStrict("Эй, Джарвис, включи музыку")).toBe(true);
    const ac = new AudioCoordinator({ sendFrame: () => {}, sendVad: () => {} });
    expect(ac.streaming).toBe(false);
  });

  it("контракты типизируются", () => {
    const s: Pick<LabServer, "port" | "url"> = { port: 8811, url: "ws://127.0.0.1:8811/ws" };
    expect(s.port).not.toBe(8787);
  });
});
