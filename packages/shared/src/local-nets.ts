/**
 * B-14 (свои адреса ПК, адверс-ревью пиннинг-прокси 27.09): правило по диапазонам (private-host.ts) не знает адресов
 * САМОГО ПК вне RFC1918 — Radmin VPN 26.x/8, Teredo, публичный IP на PPPoE, глобальный IPv6 провайдера. Сервис,
 * слушающий 0.0.0.0/:: (PostgreSQL 5432, preview 4599), по такому адресу отвечает так же, как по 127.0.0.1, а через
 * VPN видны и ПК соседей по сети (опыт: имя → 26.106.17.249, SOCKS REP 0x00, слушатель получил соединение).
 * Здесь: приватен КАЖДЫЙ адрес своих интерфейсов и их on-link префикс (address + cidr).
 *
 * Список — на момент суда (VPN подключается на ходу), кеш системного — 1 с: `os.networkInterfaces()` на Windows
 * ≈ 2 мс синхронно (главный поток Electron), а суд — на каждое соединение невидимого браузера. Префикс короче /8
 * (IPv6 — /32) — только сам адрес: TUN с маской 0.0.0.0 не должен сделать приватным весь интернет. То же у адаптера в
 * 198.18/15: это пул fake-IP (mihomo/Clash TUN — 198.18.0.1/16), через него идут ВСЕ имена — его сеть приватной
 * не делаем (иначе откажет весь веб; осознанный остаток SECURITY «SSRF по DNS» №7).
 */
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";

/** Интерфейсы в форме `os.networkInterfaces()` (DI стенда: «VPN подключился» посреди теста; вызывается на каждый суд). */
export type LocalInterfaces = () => Record<string, ReadonlyArray<{ address: string; cidr?: string | null }> | undefined>;

const MIN_PREFIX = { 4: 8, 6: 32 } as const;
const SYSTEM_TTL_MS = 1000;
const FAKE_IP_POOL = new BlockList();
FAKE_IP_POOL.addSubnet("198.18.0.0", 15, "ipv4");

function build(ifaces: ReturnType<LocalInterfaces>): BlockList {
  const list = new BlockList();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      const address = String(a?.address ?? "").replace(/%.*$/u, "");
      const fam = isIP(address);
      if (fam !== 4 && fam !== 6) continue;
      const full = fam === 4 ? 32 : 128;
      const bits = Number(/\/(\d{1,3})$/u.exec(a.cidr ?? "")?.[1] ?? full); // cidr null — маска несмежная: сам адрес
      const fakeIp = fam === 4 && FAKE_IP_POOL.check(address, "ipv4");
      const prefix = bits >= MIN_PREFIX[fam] && bits <= full && !fakeIp ? bits : full;
      try {
        list.addSubnet(address, prefix, fam === 4 ? "ipv4" : "ipv6");
      } catch {
        /* кривая запись адаптера не валит суд — остальные интерфейсы в силе */
      }
    }
  }
  return list;
}

let system: { at: number; list: BlockList } | undefined;

/**
 * Системный список не прочитался (ошибка ОС) — остаётся прежний: вердикт не хуже, чем был до этого слоя
 * (правило диапазонов в силе), и не «всё приватно» (отказ всего веба).
 */
function systemNets(): BlockList {
  const now = Date.now();
  if (system && now - system.at < SYSTEM_TTL_MS) return system.list;
  let list = system?.list ?? new BlockList();
  try {
    list = build(networkInterfaces());
  } catch {
    /* см. выше */
  }
  system = { at: now, list };
  return list;
}

function nets(interfaces?: LocalInterfaces): BlockList {
  if (!interfaces) return systemNets();
  try {
    return build(interfaces());
  } catch {
    return new BlockList();
  }
}

/**
 * Голый адрес (IPv4 точками или IPv6 без скобок и зоны) — адрес своего интерфейса или его on-link сети?
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`) BlockList сверяет и с IPv4-записями. Непарсящийся — false (его судит правило).
 */
export function isLocalNetAddress(address: string, interfaces?: LocalInterfaces): boolean {
  const fam = isIP(address);
  if (!fam) return false;
  try {
    return nets(interfaces).check(address, fam === 6 ? "ipv6" : "ipv4");
  } catch {
    return false;
  }
}
