import { describe, expect, it } from "vitest";
import { type DeviceInfo, routeNotification, userAwayFromDesktop } from "./presence.js";

const NOW = 1_000_000;
const desktop = (ago: number): DeviceInfo => ({ kind: "desktop", lastSeenAt: NOW - ago });
const mobile = (ago: number): DeviceInfo => ({ kind: "mobile", lastSeenAt: NOW - ago, pushToken: "tok" });

describe("routeNotification (§9, §20)", () => {
  it("активный десктоп → голос", () => {
    const r = routeNotification([desktop(60_000), mobile(0)], NOW);
    expect(r.target).toBe("desktop_voice");
  });
  it("десктоп неактивен → пуш на mobile", () => {
    const r = routeNotification([desktop(10 * 60_000), mobile(30_000)], NOW);
    expect(r.target).toBe("mobile_push");
    expect(r.device?.kind).toBe("mobile");
  });
  it("mobile без токена не выбирается", () => {
    const r = routeNotification([{ kind: "mobile", lastSeenAt: NOW }], NOW);
    expect(r.target).toBe("none");
  });
  it("userAwayFromDesktop", () => {
    expect(userAwayFromDesktop([desktop(10 * 60_000)], NOW)).toBe(true);
    expect(userAwayFromDesktop([desktop(60_000)], NOW)).toBe(false);
    expect(userAwayFromDesktop([], NOW)).toBe(true);
  });
});
