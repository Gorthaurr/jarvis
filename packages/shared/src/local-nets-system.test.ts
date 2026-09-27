/**
 * B-14 (свои адреса ПК): СИСТЕМНЫЙ список интерфейсов (без DI) — кеш 1 с (`os.networkInterfaces()` ≈ 2 мс синхронно
 * на Windows, суд — на каждое соединение), но не навсегда: VPN, подключённый на ходу, попадает в суд за ≤ 1 с.
 * Реверт-проверка (из копии): кеш без срока → красный «VPN подключился».
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const os = vi.hoisted(() => ({ list: {} as Record<string, Array<{ address: string; cidr: string | null }>>, calls: 0, fail: false }));
vi.mock("node:os", async (orig) => ({
  ...(await orig<typeof import("node:os")>()),
  networkInterfaces: () => {
    os.calls += 1;
    if (os.fail) throw new Error("uv_interface_addresses");
    return os.list;
  },
}));

const { isPrivateIp } = await import("./private-host.js");

afterEach(() => vi.useRealTimers());

describe("B-14: системный список интерфейсов — на момент суда, с кешем 1 с", () => {
  it("VPN подключился: до истечения кеша — прежний список, после — адрес его сети приватен; ОС спрошена раз за окно", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    os.list = { Ethernet: [{ address: "192.168.1.100", cidr: "192.168.1.100/24" }] };
    expect(isPrivateIp("26.1.2.3")).toBe(false);
    const before = os.calls;
    os.list = { ...os.list, "Radmin VPN": [{ address: "26.106.17.249", cidr: "26.106.17.249/8" }] };
    vi.advanceTimersByTime(500);
    expect(isPrivateIp("26.1.2.3")).toBe(false); // окно кеша
    expect(isPrivateIp("26.1.2.4")).toBe(false);
    expect(os.calls).toBe(before); // не 2 мс на каждый адрес ответа
    vi.advanceTimersByTime(600);
    expect(isPrivateIp("26.1.2.3")).toBe(true);
  });

  it("ОС не отдала список — остаётся прежний (не «всё приватно» и не пусто)", () => {
    vi.useFakeTimers({ now: 5_000_000 });
    os.fail = false;
    os.list = { "Radmin VPN": [{ address: "26.106.17.249", cidr: "26.106.17.249/8" }] };
    expect(isPrivateIp("26.1.2.3")).toBe(true);
    os.fail = true;
    vi.advanceTimersByTime(1500);
    expect(isPrivateIp("26.1.2.3")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    os.fail = false;
  });
});
