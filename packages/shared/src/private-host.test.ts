import { describe, expect, it } from "vitest";
import { isPrivateHost, isPrivateHttpUrl, isPrivateIp, urlHostname } from "./private-host.js";

describe("B-14: одно правило «приватный хост»", () => {
  it("приватно: loopback, RFC1918, link-local/метаданные, CGNAT, 0/8, mDNS/.internal/.localhost", () => {
    for (const u of [
      "http://127.0.0.1:8080/x",
      "http://127.1/", // WHATWG URL нормализует в 127.0.0.1
      "http://2130706433/", // десятичная запись 127.0.0.1
      "http://0x7f000001/",
      "http://10.0.0.5/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.1/admin",
      "http://169.254.169.254/latest/meta-data",
      "http://100.64.0.1/",
      "http://100.127.255.254/",
      "http://0.0.0.0/",
      "http://localhost:3000/",
      "http://api.localhost/",
      "http://router.local/",
      "http://ROUTER.LOCAL./",
      "http://metadata.google.internal/",
      "192.168.0.1",
      "localhost:8787",
    ]) {
      expect(isPrivateHost(u), u).toBe(true);
    }
  });

  it("приватно: IPv6 loopback/ULA/link-local и IPv4-mapped/-compatible с приватным IPv4 (любой записью)", () => {
    for (const u of ["http://[::1]/", "http://[::]/", "http://[fd12:3456::1]/", "http://[fc00::1]/", "http://[fe80::1]/", "http://[febf::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[::ffff:c0a8:101]/", "http://[::ffff:a9fe:a9fe]/", "http://[::127.0.0.1]/"]) {
      expect(isPrivateHost(u), u).toBe(true);
    }
  });

  it("публично: обычные сайты, похожие имена и публичные IP", () => {
    for (const u of ["https://ya.ru/", "https://fcbarcelona.com/", "https://fdj.fr/", "https://local.example.com/", "https://internal.company.com/", "http://172.32.0.1/", "http://100.128.0.1/", "http://8.8.8.8/", "http://[2001:4860::8888]/", "http://[::ffff:808:808]/", "http://11.0.0.1/"]) {
      expect(isPrivateHost(u), u).toBe(false);
    }
  });

  it("пустой/битый хост и не-http — не приватный хост (сети нет); isPrivateHttpUrl — только http(s)", () => {
    expect(isPrivateHost("")).toBe(false);
    expect(isPrivateHost("about:blank")).toBe(false);
    expect(isPrivateHttpUrl("about:blank")).toBe(false);
    expect(isPrivateHttpUrl("chrome-error://chromewebdata/")).toBe(false);
    expect(isPrivateHttpUrl("http://192.168.0.1/")).toBe(true);
    expect(isPrivateHttpUrl("ftp://192.168.0.1/")).toBe(false);
    expect(urlHostname("https://[::1]:8080/x")).toBe("::1");
  });

  it("isPrivateIp: голые адреса из ответа DNS, в т.ч. IPv6 без скобок и с зоной; мусор — приватно (fail-closed)", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1%12", "fd00::5", "::ffff:127.0.0.1", "::ffff:192.168.0.1", "[::1]", "", "not-an-ip", "fe80::zz"]) {
      expect(isPrivateIp(a), a).toBe(true);
    }
    for (const a of ["149.154.167.99", "8.8.8.8", "203.0.113.10", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
      expect(isPrivateIp(a), a).toBe(false);
    }
    // Ловушка, ради которой isPrivateIp существует: правило по имени голый IPv6 не разбирает.
    expect(isPrivateHost("::1")).toBe(false);
  });

  it("адверс-ревью: встроенный IPv4 в переходных формах IPv6, site-local, мультикаст, мусорные октеты — приватно", () => {
    for (const a of ["64:ff9b::7f00:1", "64:ff9b::127.0.0.1", "64:ff9b:1::5", "2002:7f00:1::1", "2002:c0a8:101::1", "2002:a9fe:a9fe::1", "::ffff:0:7f00:1", "2001:0:4136:e378::1", "fec0::1", "ff02::1", "224.0.0.1", "239.1.2.3", "255.255.255.255", "999.1.1.1", "01.02.03.04", "1.2.3"]) {
      expect(isPrivateIp(a), a).toBe(true);
    }
    for (const a of ["64:ff9b::808:808", "2002:808:808::1", "2001:db8::1", "2a00:1450:4010::8a", "198.18.0.1"]) {
      expect(isPrivateIp(a), a).toBe(false);
    }
    expect(isPrivateHost("http://[64:ff9b::7f00:1]/")).toBe(true);
    // Адверс-ревью р2: схема без «//» — хост тот же, что у new URL и браузера (раньше «» → суд пропускал).
    expect(urlHostname("http:evil.example")).toBe("evil.example");
    expect(urlHostname("http:\\evil.example:8787/dev/say")).toBe("evil.example");
    expect(urlHostname("https:/x.example")).toBe("x.example");
    expect(urlHostname("shop.ru:8080/x")).toBe("shop.ru"); // голый host:port — по-прежнему хост
    expect(isPrivateHttpUrl("http:localhost:8787/")).toBe(true);
    expect(isPrivateHost("http://[2002:7f00:1::]/")).toBe(true);
  });
});
