import { describe, expect, it, vi } from "vitest";
import type { ClientContext } from "@jarvis/protocol";
import { ProactiveHub } from "./hub.js";
import type { Trigger } from "./triggers/index.js";

const NOW = 1_000_000;
function trig(over: Partial<Trigger> = {}): Trigger {
  return { id: "t1", kind: "time", importance: 0.5, hint: "Пора в зал, сэр.", expiresAt: NOW + 60_000, userId: "u1", ...over };
}
const free = {} as ClientContext; // ничего не занято
const fullscreen = { fullscreen: true } as ClientContext;
const locked = { locked: true } as ClientContext;

describe("ProactiveHub (Фаза 4 — уважительная проактивная доставка)", () => {
  it("свободный контекст → доставляет сразу (speak с hint)", () => {
    const speak = vi.fn();
    const hub = new ProactiveHub(speak, { now: () => NOW });
    hub.emit(trig(), free);
    expect(speak).toHaveBeenCalledWith("u1", "Пора в зал, сэр.");
    expect(hub.pending("u1")).toBe(0);
  });

  it("занят (fullscreen, важность<0.8) → НЕ озвучивает, откладывает", () => {
    const speak = vi.fn();
    const hub = new ProactiveHub(speak, { now: () => NOW });
    hub.emit(trig({ importance: 0.5 }), fullscreen);
    expect(speak).not.toHaveBeenCalled();
    expect(hub.pending("u1")).toBe(1);
  });

  it("drain при освобождении контекста → доставляет отложенное", () => {
    const speak = vi.fn();
    const hub = new ProactiveHub(speak, { now: () => NOW });
    hub.emit(trig(), fullscreen);
    hub.drain("u1", free);
    expect(speak).toHaveBeenCalledWith("u1", "Пора в зал, сэр.");
    expect(hub.pending("u1")).toBe(0);
  });

  it("drain, но всё ещё занят → возвращает в очередь (не теряем)", () => {
    const speak = vi.fn();
    const hub = new ProactiveHub(speak, { now: () => NOW });
    hub.emit(trig(), locked);
    hub.drain("u1", locked);
    expect(speak).not.toHaveBeenCalled();
    expect(hub.pending("u1")).toBe(1);
  });

  it("протухший триггер → молча дроп (не озвучивает, не копит)", () => {
    const speak = vi.fn();
    const hub = new ProactiveHub(speak, { now: () => NOW });
    hub.emit(trig({ expiresAt: NOW - 1 }), free);
    expect(speak).not.toHaveBeenCalled();
    expect(hub.pending("u1")).toBe(0);
  });

  it("DND → голос подавлен (откладываем, не озвучиваем)", () => {
    const speak = vi.fn();
    const hub = new ProactiveHub(speak, { dnd: () => true, now: () => NOW });
    hub.emit(trig(), free);
    expect(speak).not.toHaveBeenCalled();
    expect(hub.pending("u1")).toBe(1);
  });

  it("критический триггер (importance≥0.95) пробивает fullscreen, но НЕ locked", () => {
    const s1 = vi.fn();
    new ProactiveHub(s1, { now: () => NOW }).emit(trig({ importance: 0.97 }), fullscreen);
    expect(s1).toHaveBeenCalled(); // fullscreen пробит
    const s2 = vi.fn();
    const hub2 = new ProactiveHub(s2, { now: () => NOW });
    hub2.emit(trig({ importance: 0.97 }), locked);
    expect(s2).not.toHaveBeenCalled(); // locked — нет
    expect(hub2.pending("u1")).toBe(1);
  });
});
