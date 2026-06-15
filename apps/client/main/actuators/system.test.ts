import { describe, expect, it } from "vitest";
import { planSystem } from "./system.js";

describe("system actuator (§6) — построение команд (анти-инъекция)", () => {
  it("lock → rundll32 LockWorkStation", () => {
    const p = planSystem({ kind: "system.lock" });
    expect(p.exe).toBe("rundll32.exe");
    expect(p.args).toEqual(["user32.dll,LockWorkStation"]);
  });

  it("power: shutdown/restart/logoff/sleep — корректные exe/args", () => {
    expect(planSystem({ kind: "system.power", op: "shutdown" })).toMatchObject({ exe: "shutdown", args: ["/s", "/t", "0"] });
    expect(planSystem({ kind: "system.power", op: "restart" })).toMatchObject({ args: ["/r", "/t", "0"] });
    expect(planSystem({ kind: "system.power", op: "logoff" })).toMatchObject({ args: ["/l"] });
    expect(planSystem({ kind: "system.power", op: "sleep" }).exe).toBe("rundll32.exe");
  });

  it("media → powershell с VK media-клавиши", () => {
    const p = planSystem({ kind: "system.media", op: "play" });
    expect(p.exe).toBe("powershell");
    expect(p.args.at(-1)).toContain("keybd_event");
    expect(planSystem({ kind: "system.media", op: "next" }).args.at(-1)).toContain("keybd_event");
  });

  it("volume set кладёт level в скрипт Core Audio", () => {
    const p = planSystem({ kind: "system.volume", op: "set", level: 30 });
    expect(p.args.at(-1)).toContain("0.300");
  });

  it("volume up/down/mute → keybd_event", () => {
    expect(planSystem({ kind: "system.volume", op: "up" }).args.at(-1)).toContain("keybd_event");
    expect(planSystem({ kind: "system.volume", op: "mute" }).args.at(-1)).toContain("keybd_event");
  });

  it("clipboard write передаёт текст через env, а не в командную строку (анти-инъекция)", () => {
    const evil = "'; Remove-Item C:\\ -Recurse; '";
    const p = planSystem({ kind: "system.clipboard", op: "write", text: evil });
    // Текст НЕ должен попасть в аргументы команды.
    expect(p.args.join(" ")).not.toContain("Remove-Item");
    expect(p.env?.JARVIS_CLIP).toBe(evil);
    expect(p.args.at(-1)).toContain("$env:JARVIS_CLIP");
  });

  it("clipboard read помечен captureStdout", () => {
    const p = planSystem({ kind: "system.clipboard", op: "read" });
    expect(p.captureStdout).toBe(true);
    expect(p.args.at(-1)).toContain("Get-Clipboard");
  });
});
