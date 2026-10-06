import net from "node:net";
export const LIVE_PORT = 8787;
export const LAB_PORT_MIN = 8811;
export const LAB_PORT_MAX = 8899;

export function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/** Each pool owns an OS socket namespace; tests can reserve a private range without competing with live labs. */
export function createPortPool(min = LAB_PORT_MIN, max = LAB_PORT_MAX, leaseOffset = 20_000) {
  if (![min, max, leaseOffset].every(Number.isInteger) || min < 1 || max < min || max > 65535
    || !leaseOffset || min + leaseOffset < 1 || max + leaseOffset > 65535) throw new Error("invalid port pool");
  const claimed = new Set<number>();
  // The extra loopback listener holds the lease across workers while HTTP is still unbound (PGlite/startup).
  // An OS lease disappears automatically if the owning process dies; no stale lock files need deleting.
  const leases = new Map<number, net.Server>();

  async function reserve(port: number): Promise<boolean> {
    if (claimed.has(port)) return false;
    const lease = net.createServer((socket) => socket.destroy());
    const acquired = await new Promise<boolean>((resolve) => {
      lease.once("error", () => resolve(false));
      lease.listen(port + leaseOffset, "127.0.0.1", () => resolve(true));
    });
    if (!acquired) return false;
    lease.unref();
    if (!(await isPortFree(port))) { lease.close(); return false; }
    leases.set(port, lease);
    claimed.add(port);
    return true;
  }

  /** `avoid` includes ports already registered by the CLI. */
  async function claimPort(preferred?: number, avoid: number[] = []): Promise<number> {
    if (preferred === LIVE_PORT) throw new Error(`порт ${LIVE_PORT} — БОЕВОЙ сервер владельца, лаборатория его не использует`);
    if (preferred) {
      if (!Number.isInteger(preferred) || preferred < min || preferred > max) throw new Error(`порт ${preferred} вне диапазона лаборатории ${min}..${max}`);
      if (avoid.includes(preferred) || !(await reserve(preferred))) throw new Error(`порт ${preferred} занят`);
      return preferred;
    }
    const span = max - min + 1;
    const start = Math.floor(Math.random() * span);
    for (let i = 0; i < span; i += 1) {
      const port = min + ((start + i) % span);
      if (port === LIVE_PORT || claimed.has(port) || avoid.includes(port)) continue;
      if (await reserve(port)) return port;
    }
    throw new Error(`нет свободного порта ${min}..${max}`);
  }

  function releasePort(port: number): void {
    leases.get(port)?.close();
    leases.delete(port);
    claimed.delete(port);
  }
  return { claimed, claimPort, releasePort };
}

export const { claimed, claimPort, releasePort } = createPortPool();
