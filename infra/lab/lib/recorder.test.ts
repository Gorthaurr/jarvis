import { describe, expect, it } from "vitest";
import { EventRecorder } from "./recorder.js";

describe("рекордер событий", () => {
  it("хранит порядок, время из часов и id конверта", () => {
    let t = 100;
    const r = new EventRecorder(10, () => t++);
    r.push("out", "client.hello", { a: 1 });
    r.push("in", "action.command", { kind: "x" }, "cmd-1");
    expect(r.all().map((e) => [e.dir, e.type, e.at, e.id])).toEqual([["out", "client.hello", 100, undefined], ["in", "action.command", 101, "cmd-1"]]);
  });

  it("since(mark) отдаёт только новое, и метка переживает обрезку кольца", () => {
    const r = new EventRecorder(3);
    for (let i = 0; i < 3; i += 1) r.push("in", `e${i}`, i);
    const mark = r.length; // 3
    for (let i = 3; i < 6; i += 1) r.push("in", `e${i}`, i); // кольцо вытеснило e0..e2
    expect(r.since(mark).map((e) => e.type)).toEqual(["e3", "e4", "e5"]);
    expect(r.length).toBe(6);
  });

  it("подписчик получает событие сразу и может отписаться", () => {
    const r = new EventRecorder();
    const got: string[] = [];
    const off = r.subscribe((e) => got.push(e.type));
    r.push("in", "a", 0);
    off();
    r.push("in", "b", 0);
    expect(got).toEqual(["a"]);
  });
});
