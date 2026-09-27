/**
 * B-14 (свои адреса ПК): адрес своего интерфейса и его on-link сеть — приватны в ОБЩЕМ правиле (им судят сервер,
 * гард навигации и прокси пиннинга). Список интерфейсов — DI (`interfaces`), кроме живого кейса на настоящем ПК.
 * Сети фикстур (7/8 в роли Radmin 26/8, 2a02:6b8:1:2::/64, 95.30.40.50) НЕ пересекаются с интерфейсами этого ПК — иначе
 * настоящий список подстраховал бы потерянный проброс `interfaces` (адверс-ревью р1: на ПК владельца с Radmin 26.x
 * мутация «IPv4-ветка isPrivateHost без interfaces» оставалась зелёной). Первый кейс это и сторожит.
 *
 * Реверт-проверки (из копии): private-host без `isLocalNetAddress` → красные Radmin/IPv6/встроенный IPv4/«VPN
 * подключился» и живой кейс (на ПК владельца — 26.106.17.249); встроенный IPv4 по двум октетам → красный
 * «встроенный IPv4»; без пола префикса → красный «/0»; кеш системного списка навсегда → красный в local-nets-system.
 */
import { networkInterfaces } from "node:os";
import { describe, expect, it } from "vitest";
import type { LocalInterfaces } from "./local-nets.js";
import { isPrivateHost, isPrivateHttpUrl, isPrivateIp } from "./private-host.js";

/** Форма ПК владельца 27.09 (`os.networkInterfaces()`: Radmin — /8), плюс PPPoE и глобальный IPv6 провайдера. */
const OWNER_PC: LocalInterfaces = () => ({
  "Radmin VPN": [
    { address: "7.106.17.249", cidr: "7.106.17.249/8" },
    { address: "fdfd::1a6a:11f9", cidr: "fdfd::1a6a:11f9/64" },
  ],
  Ethernet: [
    { address: "192.168.1.100", cidr: "192.168.1.100/24" },
    { address: "2a02:6b8:1:2::5", cidr: "2a02:6b8:1:2::5/64" },
  ],
  PPPoE: [{ address: "95.30.40.50", cidr: "95.30.40.50/32" }],
});

describe("B-14: свои адреса ПК и их on-link сети — приватны", () => {
  it("сторож фикстур: их сети НЕ принадлежат интерфейсам этого ПК (иначе DI-кейсы ничего не доказывают)", () => {
    // Все адреса DI-фикстур файла, кроме 198.18.0.1 (fake-IP: у ПК с mihomo он свой — кейс это и проверяет).
    const fixtures = ["7.1.2.3", "2a02:6b8:1:2::abcd", "95.30.40.50", "5.6.7.8", "9.9.9.1", "2a00:1::1", "7.7.7.7", "1.2.3.4"];
    for (const ip of fixtures) expect(isPrivateIp(ip), `${ip} — сеть этого ПК, смени фикстуру`).toBe(false);
  });

  it("VPN-адаптер /8 (как Radmin 26.106.17.249/8): свой адрес и соседи по сети — приватно; вне /8 и интернет — публично", () => {
    for (const ip of ["7.106.17.249", "7.1.2.3", "7.255.255.254", "95.30.40.50"]) expect(isPrivateIp(ip, OWNER_PC), ip).toBe(true);
    for (const ip of ["8.0.0.1", "6.255.255.255", "8.8.8.8", "95.30.40.51"]) expect(isPrivateIp(ip, OWNER_PC), ip).toBe(false);
  });

  it("литерал в URL (web.fetch, browser-cdp, ответы вкладок) — тем же правилом", () => {
    expect(isPrivateHost("http://7.106.17.249:5432/", OWNER_PC)).toBe(true);
    expect(isPrivateHost("http://0x7.1.2.3:5432/", OWNER_PC)).toBe(true); // WHATWG нормализует в 7.1.2.3
    expect(isPrivateHttpUrl("http://7.1.2.3:4599/", OWNER_PC)).toBe(true);
    expect(isPrivateHost("http://[2a02:6b8:1:2::abcd]/", OWNER_PC)).toBe(true);
    expect(isPrivateHost("https://8.8.8.8/", OWNER_PC)).toBe(false);
    expect(isPrivateHost("https://example.com/", OWNER_PC)).toBe(false);
  });

  it("свой глобальный IPv6 и его /64 — приватно; соседняя /64 и чужой IPv6 — публично", () => {
    for (const ip of ["2a02:6b8:1:2::5", "2a02:6b8:1:2::abcd", "2A02:06B8:0001:0002:ffff:ffff:ffff:ffff"]) expect(isPrivateIp(ip, OWNER_PC), ip).toBe(true);
    for (const ip of ["2a02:6b8:1:3::1", "2a00:1450:4010::65"]) expect(isPrivateIp(ip, OWNER_PC), ip).toBe(false);
  });

  it("встроенный IPv4 (mapped/compatible/SIIT/NAT64/6to4) судится ЦЕЛИКОМ по своим сетям, не по двум октетам", () => {
    for (const ip of ["::ffff:7.1.2.3", "::ffff:701:203", "::7.1.2.3", "::ffff:0:701:203", "64:ff9b::701:203", "2002:701:203::1", "2002:5f1e:2832::7"]) {
      expect(isPrivateIp(ip, OWNER_PC), ip).toBe(true);
    }
    for (const ip of ["::ffff:8.0.0.1", "64:ff9b::808:808", "2002:5f1e:2833::1"]) expect(isPrivateIp(ip, OWNER_PC), ip).toBe(false);
  });

  it("кривой адаптер: маска 0.0.0.0 (/0), /4, IPv6 /16, cidr null — приватен только сам адрес, интернет не «внутренний»", () => {
    const broken: LocalInterfaces = () => ({
      tun: [{ address: "5.6.7.8", cidr: "5.6.7.8/0" }, { address: "9.9.9.1", cidr: "9.9.9.1/4" }, { address: "2a00:1::1", cidr: "2a00:1::1/16" }],
      odd: [{ address: "7.7.7.7", cidr: null }, { address: "мусор", cidr: "x/8" }, { address: "1.2.3.4", cidr: "1.2.3.4/99" }],
    });
    for (const ip of ["5.6.7.8", "9.9.9.1", "2a00:1::1", "7.7.7.7", "1.2.3.4"]) expect(isPrivateIp(ip, broken), ip).toBe(true);
    for (const ip of ["8.8.8.8", "5.6.7.9", "9.9.9.2", "2a00:2::1", "7.7.7.8", "1.2.3.5"]) expect(isPrivateIp(ip, broken), ip).toBe(false);
  });

  it("TUN с fake-IP (mihomo/Clash: адаптер 198.18.0.1/16 — тот же пул, что у ВСЕХ имён): сеть не приватна, только сам адрес", () => {
    const mihomo: LocalInterfaces = () => ({ Mihomo: [{ address: "198.18.0.1", cidr: "198.18.0.1/16" }], Ethernet: [{ address: "7.106.17.249", cidr: "7.106.17.249/8" }] });
    expect(isPrivateIp("198.18.0.1", mihomo)).toBe(true);
    for (const ip of ["198.18.0.5", "198.18.3.7", "198.19.0.1"]) expect(isPrivateIp(ip, mihomo), ip).toBe(false);
    expect(isPrivateIp("7.1.2.3", mihomo)).toBe(true); // остальные интерфейсы — как обычно
  });

  it("список — на момент суда: VPN подключился посреди работы → адрес приватен; отключился → снова публичный", () => {
    let vpn = false;
    const live: LocalInterfaces = () => ({
      Ethernet: [{ address: "192.168.1.100", cidr: "192.168.1.100/24" }],
      ...(vpn ? { "Radmin VPN": [{ address: "7.106.17.249", cidr: "7.106.17.249/8" }] } : {}),
    });
    expect(isPrivateIp("7.1.2.3", live)).toBe(false);
    vpn = true;
    expect(isPrivateIp("7.1.2.3", live)).toBe(true);
    expect(isPrivateHost("http://7.1.2.3/", live)).toBe(true);
    vpn = false;
    expect(isPrivateIp("7.1.2.3", live)).toBe(false);
  });

  it("провайдер интерфейсов бросил — суд не падает, правило диапазонов в силе", () => {
    const failing: LocalInterfaces = () => {
      throw new Error("uv_interface_addresses");
    };
    expect(isPrivateIp("10.0.0.1", failing)).toBe(true);
    expect(isPrivateIp("8.8.8.8", failing)).toBe(false);
  });

  it("по умолчанию — НАСТОЯЩИЕ интерфейсы этого ПК: каждый их адрес приватен (на ПК владельца — Radmin 26.x, Teredo)", () => {
    const own = Object.values(networkInterfaces()).flatMap((l) => l ?? []).map((a) => a.address);
    expect(own.length).toBeGreaterThan(0);
    for (const ip of own) {
      expect(isPrivateIp(ip), ip).toBe(true);
      expect(isPrivateHost(ip.includes(":") ? `http://[${ip}]/` : `http://${ip}/`), ip).toBe(true);
    }
  });
});
