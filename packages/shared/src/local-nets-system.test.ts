/**
 * B-14 (свои адреса ПК): СИСТЕМНЫЙ список интерфейсов (без DI) — кеш 1 с (`os.networkInterfaces()` ≈ 2 мс синхронно
 * на Windows, суд — на каждое соединение), но не навсегда: VPN, подключённый на ходу, попадает в суд за ≤ 1 с.
 * Реверт-проверка (из копии): кеш без срока → красный «VPN подключился»; возраст кеша без учёта шага часов назад →
 * красный «часы назад»; сбой ОС не обновляет метку кеша → красный «ОС не отдала список».
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

  it("часы шагнули назад на час (W32Time/ручная правка): список не замерзает на час — VPN виден сразу", () => {
    vi.useFakeTimers({ now: 9_000_000_000 });
    os.list = { Ethernet: [{ address: "192.168.1.100", cidr: "192.168.1.100/24" }] };
    expect(isPrivateIp("26.1.2.3")).toBe(false);
    vi.setSystemTime(9_000_000_000 - 3_600_000);
    os.list = { ...os.list, "Radmin VPN": [{ address: "26.106.17.249", cidr: "26.106.17.249/8" }] };
    expect(isPrivateIp("26.1.2.3")).toBe(true);
  });

  it("ОС не отдала список — остаётся прежний (не «всё приватно» и не пусто)", () => {
    vi.useFakeTimers({ now: 20_000_000_000 }); // позже прочих кейсов: кеш модуля общий, шаг назад здесь не нужен
    os.fail = false;
    os.list = { "Radmin VPN": [{ address: "26.106.17.249", cidr: "26.106.17.249/8" }] };
    expect(isPrivateIp("26.1.2.3")).toBe(true);
    os.fail = true;
    vi.advanceTimersByTime(1500);
    const before = os.calls;
    expect(isPrivateIp("26.1.2.3")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("26.1.2.4")).toBe(true);
    expect(os.calls - before).toBe(1); // сбой ОС не снимает кеш: не 2 мс и исключение на КАЖДЫЙ суд (контроль р2)
    vi.advanceTimersByTime(1000);
    isPrivateIp("26.1.2.3");
    expect(os.calls - before).toBe(2); // и повтор — не раньше, чем через 1 с
    os.fail = false;
  });
});
