import { describe, expect, it } from "vitest";
import { planSystem } from "./system.js";

describe("system actuator (§6) — построение команд (анти-инъекция)", () => {
  it("lock → rundll32 LockWorkStation", () => {
    const p = planSystem({ kind: "system.lock" });
    expect(p.exe).toBe("rundll32.exe");
    expect(p.args).toEqual(["user32.dll,LockWorkStation"]);
  });

  it("ЗАЩИТА §4: shutdown/restart — ОТЛОЖЕННЫЕ, с предупреждением и окном отмены (НЕ /t 0)", () => {
    const sd = planSystem({ kind: "system.power", op: "shutdown" }, 25);
    expect(sd.exe).toBe("shutdown");
    expect(sd.args.slice(0, 4)).toEqual(["/s", "/t", "25", "/c"]); // задержка 25с, не 0
    expect(sd.args.at(-1)).toContain("отмен"); // предупреждение про отмену
    expect(sd.args).not.toContain("0"); // НИКОГДА не мгновенно

    const rs = planSystem({ kind: "system.power", op: "restart" }, 25);
    expect(rs.args.slice(0, 4)).toEqual(["/r", "/t", "25", "/c"]);

    expect(planSystem({ kind: "system.power", op: "logoff" })).toMatchObject({ args: ["/l"] });
    expect(planSystem({ kind: "system.power", op: "sleep" }).exe).toBe("rundll32.exe");
  });

  it("power cancel → shutdown /a (отмена запланированного), терпит ненулевой код", () => {
    const c = planSystem({ kind: "system.power", op: "cancel" });
    expect(c).toMatchObject({ exe: "shutdown", args: ["/a"], tolerateFailure: true });
  });

  it("задержка выключения настраивается (окно отмены), но никогда не 0", () => {
    expect(planSystem({ kind: "system.power", op: "shutdown" }, 60).args[2]).toBe("60");
  });

  it("media → powershell с VK media-клавиши", () => {
    const p = planSystem({ kind: "system.media", op: "play" });
    expect(p.exe).toBe("powershell");
    expect(p.args.at(-1)).toContain("keybd_event");
    expect(planSystem({ kind: "system.media", op: "next" }).args.at(-1)).toContain("keybd_event");
  });

  it("media state → WASAPI peak (наблюдение «играет ли звук»), captureStdout, НЕ клавиша", () => {
    const p = planSystem({ kind: "system.media", op: "state" });
    expect(p.args.at(-1)).not.toContain("keybd_event");
    expect(p.args.at(-1)).toContain("GetPeakValue");
    expect(p.captureStdout).toBe(true);
  });

  it("volume set кладёт level в скрипт Core Audio + readback (verify-loop)", () => {
    const p = planSystem({ kind: "system.volume", op: "set", level: 30 });
    expect(p.args.at(-1)).toContain("0.300");
    expect(p.args.at(-1)).toContain("[Vol]::Get()"); // обратное чтение результата
    expect(p.captureStdout).toBe(true);
  });

  it("volume up/down/mute/get → Core Audio (НЕ глобальные клавиши), с обратным чтением", () => {
    for (const op of ["up", "down", "mute", "get"] as const) {
      const p = planSystem({ kind: "system.volume", op });
      expect(p.args.at(-1)).not.toContain("keybd_event"); // больше не глобальная клавиша
      expect(p.args.at(-1)).toContain("Vol");
      expect(p.captureStdout).toBe(true);
    }
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

  it("layout (раскладка) → Win32 в foreground-окно + readback (verify), en=0409/ru=0419", () => {
    const en = planSystem({ kind: "system.layout", lang: "en" });
    expect(en.exe).toBe("powershell");
    expect(en.captureStdout).toBe(true);
    expect(en.args.at(-1)).toContain("00000409"); // EN раскладка
    expect(en.args.at(-1)).toContain("LoadKeyboardLayout");
    expect(en.args.at(-1)).toContain("GetForegroundWindow"); // применяем к активному окну (игре)
    expect(en.args.at(-1)).toContain("GetKeyboardLayout"); // обратное чтение = verify
    const ru = planSystem({ kind: "system.layout", lang: "ru" });
    expect(ru.args.at(-1)).toContain("00000419"); // RU раскладка
    const tg = planSystem({ kind: "system.layout", lang: "toggle" });
    expect(tg.args.at(-1)).toContain("0x419"); // toggle решает по текущей
  });
});
