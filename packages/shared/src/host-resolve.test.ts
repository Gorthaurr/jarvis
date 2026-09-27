import { describe, expect, it } from "vitest";
import { type HostLookup, checkHostPublic } from "./host-resolve.js";

/** Таблица имён вместо DNS; счётчик — чтобы видеть, ходили ли в резолвер вообще. */
function table(map: Record<string, string[] | Error | "hang">): HostLookup & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (host: string): Promise<string[]> => {
    calls.push(host);
    const v = map[host];
    if (v === "hang") return new Promise<string[]>(() => undefined);
    if (v instanceof Error) throw v;
    if (!v) throw Object.assign(new Error(`нет ${host}`), { code: "ENOTFOUND" });
    return v;
  };
  return Object.assign(fn, { calls });
}

describe("B-14 (DNS): суд над хостом по ответу резолвера", () => {
  it("публичное имя с публичными адресами → ok и ВСЕ адреса (их и пиннит подключающийся)", async () => {
    const lookup = table({ "shop.example": ["203.0.113.10", "2001:db8::1"] });
    expect(await checkHostPublic("shop.example", { lookup })).toEqual({ ok: true, addresses: ["203.0.113.10", "2001:db8::1"] });
  });

  it("имя, указывающее на loopback (localtest.me-класс), и мультизапись «публичный + приватный» → private", async () => {
    const lookup = table({ "localtest.me": ["127.0.0.1"], "mixed.example": ["203.0.113.10", "10.0.0.7"], "v6.example": ["::1"] });
    expect(await checkHostPublic("localtest.me", { lookup })).toEqual({ ok: false, reason: "private", address: "127.0.0.1" });
    expect(await checkHostPublic("MIXED.example.", { lookup })).toEqual({ ok: false, reason: "private", address: "10.0.0.7" });
    expect(await checkHostPublic("v6.example", { lookup })).toEqual({ ok: false, reason: "private", address: "::1" });
  });

  it("не разрешилось / пустой ответ / резолвер завис → unresolved (не «публично»)", async () => {
    const lookup = table({ "empty.example": [], "hang.example": "hang" });
    expect(await checkHostPublic("nx.example", { lookup })).toMatchObject({ ok: false, reason: "unresolved", detail: "ENOTFOUND" });
    expect(await checkHostPublic("empty.example", { lookup })).toMatchObject({ ok: false, reason: "unresolved" });
    expect(await checkHostPublic("hang.example", { lookup, timeoutMs: 50 })).toMatchObject({ ok: false, reason: "unresolved", detail: "ETIMEOUT" });
    expect(await checkHostPublic("", { lookup })).toMatchObject({ ok: false, reason: "unresolved" });
  });

  it("IP-литерал и имя из правила по имени судятся БЕЗ резолва", async () => {
    const lookup = table({});
    expect(await checkHostPublic("[::1]", { lookup })).toEqual({ ok: false, reason: "private", address: "::1" });
    expect(await checkHostPublic("192.168.0.1", { lookup })).toMatchObject({ ok: false, reason: "private" });
    expect(await checkHostPublic("8.8.8.8", { lookup })).toEqual({ ok: true, addresses: ["8.8.8.8"] });
    expect(await checkHostPublic("router.local", { lookup })).toMatchObject({ ok: false, reason: "private" });
    expect(lookup.calls).toEqual([]);
  });
});
