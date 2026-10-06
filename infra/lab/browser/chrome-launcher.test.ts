/** Аргументы запуска браузера лаборатории (без запуска Chrome): изоляция сети, профиля и отладки зафиксирована строками. */
import { describe, expect, it } from "vitest";
import { chromeArgs, hostRules } from "./chrome-launcher.js";

describe("аргументы браузера лаборатории", () => {
  it("правила резолвера: хосты фикстур -> loopback:порт, остальное NOTFOUND, loopback исключён", () => {
    expect(hostRules(["a.lab.test", "online.sberbank.ru"], 4321)).toBe(
      "MAP a.lab.test 127.0.0.1:4321, MAP online.sberbank.ru 127.0.0.1:4321, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
    );
    // MAP * идёт ПОСЛЕ конкретных хостов (правила применяются по порядку), а EXCLUDE держит CDP/WS к лаб-серверу живыми.
    const rules = hostRules(["x.test"], 1).split(", ");
    expect(rules.indexOf("MAP x.test 127.0.0.1:1")).toBeLessThan(rules.indexOf("MAP * ~NOTFOUND"));
    expect(hostRules([], 1)).toBe("MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost");
  });

  const args = chromeArgs({ fixtureHosts: ["h.test"], fixturePort: 999 }, "C:/tmp/jarvis-lab/chrome-x/profile");

  it("окон на ПК нет, профиль только временный, системный прокси/VPN владельца обойдён", () => {
    expect(args).toContain("--headless=new");
    expect(args).toContain("--user-data-dir=C:/tmp/jarvis-lab/chrome-x/profile");
    expect(args.filter((a) => a.startsWith("--user-data-dir="))).toHaveLength(1);
    expect(args).toContain("--no-proxy-server");
    expect(args).toContain("--host-resolver-rules=MAP h.test 127.0.0.1:999, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost");
  });

  it("отладка только по трубе: ни TCP-порта отладки, ни --load-extension (Chrome >= 137 его игнорирует)", () => {
    expect(args).toContain("--remote-debugging-pipe");
    expect(args).toContain("--enable-unsafe-extension-debugging");
    expect(args.some((a) => a.startsWith("--remote-debugging-port") || a.startsWith("--remote-debugging-address"))).toBe(false);
    expect(args.some((a) => a.startsWith("--load-extension"))).toBe(false);
  });
});
