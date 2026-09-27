import { describe, expect, it } from "vitest";
import { isPrivateHost, isPrivateHttpUrl, urlHostname } from "./private-host.js";

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
});
