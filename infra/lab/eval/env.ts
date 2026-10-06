/** Настоящие зависимости раннера: изолированный сервер лаборатории, WS-клиент по протоколу, FakeDesktop. Грузятся лениво. */
import type { EvalDeps } from "./types.js";

export async function realDeps(): Promise<EvalDeps> {
  const [{ startLabServer }, { connectLabClient }, { createFakeDesktop }] = await Promise.all([import("../lib/server.js"), import("../lib/client.js"), import("../desktop/index.js")]);
  return {
    startServer: (o) => startLabServer(o),
    connectClient: (o) => connectLabClient(o),
    createDesktop: (seed) => createFakeDesktop(seed),
  };
}
