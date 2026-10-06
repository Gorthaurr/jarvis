/**
 * CLI `say`: подключить лаб-клиента к живому лаб-серверу, сказать реплику, напечатать TurnResult и ИТОГОВЫЙ снимок FakeDesktop.
 * Рабочий стол — createFakeDesktop() из ../desktop/index.ts (CLI не зависит от того, какие обработчики уже наполнены).
 */
import { readFileSync } from "node:fs";
import { createFakeDesktop } from "../desktop/index.js";
import { connectLabClient } from "./client.js";
import type { DesktopSeed } from "./contracts.js";
import { parseConfirmPolicy } from "./policy.js";
import { attachLabServer } from "./server.js";
import { type Args, flag, pickEntry } from "./server-cli.js";

export async function cmdSay(a: Args): Promise<unknown> {
  const text = a.pos.join(" ").trim();
  if (!text) throw new Error('нужна реплика: lab.ts say "открой блокнот"');
  const entry = pickEntry(flag(a, "server"));
  const seedFile = flag(a, "seed");
  const seed = seedFile ? (JSON.parse(readFileSync(seedFile, "utf8")) as DesktopSeed) : undefined;
  const confirm = flag(a, "confirm");
  const desktop = createFakeDesktop(seed);
  const client = await connectLabClient({
    server: attachLabServer(entry),
    desktop,
    // Один пользователь на сервер: последовательные `say` делят память (--fresh — чистая партиция).
    ...(a.flags.fresh === true ? {} : { token: entry.clientToken }),
    ...(confirm ? { confirm: parseConfirmPolicy(confirm) } : {}),
    ...(flag(a, "client-version") ? { clientVersion: flag(a, "client-version") as string } : {}),
  });
  try {
    const timeout = flag(a, "timeout");
    const turn = await client.say(text, { waitTasks: a.flags["no-wait-tasks"] !== true, ...(timeout ? { timeoutMs: Number(timeout) } : {}) });
    return { turn, decisions: client.decisions(), desktop: desktop.snapshot() };
  } finally {
    await client.close();
  }
}
