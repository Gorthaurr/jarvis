import { describe, expect, it } from "vitest";
import { isFetchUrlAllowed } from "./web.js";

describe("isFetchUrlAllowed — SSRF-гард (§14)", () => {
  it("разрешает обычные публичные http(s) URL", () => {
    expect(isFetchUrlAllowed("https://example.com/page")).toBe(true);
    expect(isFetchUrlAllowed("http://news.site.ru/a/b?x=1")).toBe(true);
    expect(isFetchUrlAllowed("https://8.8.8.8/")).toBe(true);
  });

  it("блокирует не-http(s) схемы", () => {
    expect(isFetchUrlAllowed("file:///C:/secret.txt")).toBe(false);
    expect(isFetchUrlAllowed("ftp://host/x")).toBe(false);
    expect(isFetchUrlAllowed("not a url")).toBe(false);
  });

  it("блокирует localhost и приватные IPv4", () => {
    expect(isFetchUrlAllowed("http://localhost/")).toBe(false);
    expect(isFetchUrlAllowed("http://127.0.0.1/")).toBe(false);
    expect(isFetchUrlAllowed("http://10.0.0.5/")).toBe(false);
    expect(isFetchUrlAllowed("http://192.168.1.1/")).toBe(false);
    expect(isFetchUrlAllowed("http://172.16.0.1/")).toBe(false);
    expect(isFetchUrlAllowed("http://169.254.169.254/latest/meta-data")).toBe(false); // cloud metadata
    expect(isFetchUrlAllowed("http://0.0.0.0/")).toBe(false);
  });

  it("блокирует IPv6 loopback/ULA/link-local и IPv4-mapped (скобки в hostname)", () => {
    expect(isFetchUrlAllowed("http://[::1]/")).toBe(false);
    expect(isFetchUrlAllowed("http://[::]/")).toBe(false);
    expect(isFetchUrlAllowed("http://[fc00::1]/")).toBe(false);
    expect(isFetchUrlAllowed("http://[fe80::1]/")).toBe(false);
    expect(isFetchUrlAllowed("http://[::ffff:127.0.0.1]/")).toBe(false);
  });
});
