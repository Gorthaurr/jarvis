// Предзагрузка ЛАБ-сервера (NODE_OPTIONS=--import=<этот файл>): детерминированный DNS-суд навигации.
// У сервера единственный шов для DNS-судьи — globalThis.__jarvisTestNavLookup (nav-dns.ts, им пользуются тесты сервера).
// Без него лаб-сервер ходил бы в системный DNS: результат зависел бы от сети и VPN владельца, а SSRF-имена вроде
// «указывает на 10.0.0.5» в живой сети не воспроизвести. Таблица — из LAB_DNS_TABLE (JSON: имя -> [адреса]);
// имени нет в таблице — ENOTFOUND (как NXDOMAIN: сервер такое имя пропускает, резолвит браузер).
const table = JSON.parse(process.env.LAB_DNS_TABLE ?? "{}");

globalThis.__jarvisTestNavLookup = async (host) => {
  const addresses = table[String(host).toLowerCase()];
  if (addresses) return addresses;
  throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
};
