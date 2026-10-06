import net from "node:net";
export const LIVE_PORT = 8787;
export const LAB_PORT_MIN = 8811;
export const LAB_PORT_MAX = 8899;

/** Порты, выданные в этом процессе и ещё не освобождённые (два параллельных старта не должны взять один порт). */
export const claimed = new Set<number>();

export function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/** Свободный порт лаборатории. `avoid` — порты уже зарегистрированных лаб-серверов (из state.json). */
export async function claimPort(preferred?: number, avoid: number[] = []): Promise<number> {
  if (preferred === LIVE_PORT) throw new Error(`порт ${LIVE_PORT} — БОЕВОЙ сервер владельца, лаборатория его не использует`);
  if (preferred) {
    if (claimed.has(preferred) || !(await isPortFree(preferred))) throw new Error(`порт ${preferred} занят`);
    claimed.add(preferred);
    return preferred;
  }
  const span = LAB_PORT_MAX - LAB_PORT_MIN + 1;
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i += 1) {
    const port = LAB_PORT_MIN + ((start + i) % span);
    if (port === LIVE_PORT || claimed.has(port) || avoid.includes(port)) continue;
    if (await isPortFree(port)) {
      claimed.add(port);
      return port;
    }
  }
  throw new Error(`нет свободного порта ${LAB_PORT_MIN}..${LAB_PORT_MAX}`);
}

export function releasePort(port: number): void {
  claimed.delete(port);
}
