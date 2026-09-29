import { describe, expect, it } from "vitest";
import { makeKit } from "./system-test-kit.js";

const kinds = (k: ReturnType<typeof makeKit>, kind: string) => k.core.effects.filter((e) => e.kind === kind).map((e) => e.detail);

describe("system.lock / system.power", () => {
  it("lock блокирует виртуальную сессию и пишет эффект; ответ {ok:true}", async () => {
    const k = makeKit();
    expect(await k.data({ kind: "system.lock" })).toEqual({ ok: true });
    expect(k.core.locked).toBe(true);
    expect(kinds(k, "system.lock")).toEqual([{ wasLocked: false }]);
  });

  it("shutdown/restart — только ОТЛОЖЕННО (25 с, окно отмены), ОС не трогается; повторный до отмены → код 1190", async () => {
    const k = makeKit();
    expect(await k.data({ kind: "system.power", op: "shutdown" })).toEqual({ ok: true });
    const e = kinds(k, "system.power")[0]!;
    expect(e).toMatchObject({ op: "shutdown", delaySec: 25, deadlineAt: 25_000 });
    expect(String(e.warning)).toContain("отмена");
    expect(await k.err({ kind: "system.power", op: "restart" })).toContain("1190");
    await k.data({ kind: "system.power", op: "cancel" });
    expect(kinds(k, "system.power").at(-1)).toEqual({ op: "cancel", hadPending: true });
    await k.data({ kind: "system.power", op: "restart" }); // после отмены снова можно
    expect(k.core.locked).toBe(false);
  });

  it("cancel без ожидающего — тоже ok (hadPending:false); окно истекло → отменять уже нечего; sleep/logoff — эффект", async () => {
    const k = makeKit();
    await k.data({ kind: "system.power", op: "cancel" });
    expect(kinds(k, "system.power")[0]).toEqual({ op: "cancel", hadPending: false });
    await k.data({ kind: "system.power", op: "shutdown" });
    k.core.advance(26_000);
    await k.data({ kind: "system.power", op: "cancel" });
    expect(kinds(k, "system.power").at(-1)).toEqual({ op: "cancel", hadPending: false });
    await k.data({ kind: "system.power", op: "sleep" });
    await k.data({ kind: "system.power", op: "logoff" });
    expect(kinds(k, "system.power").slice(-2).map((d) => d.op)).toEqual(["sleep", "logoff"]);
  });
});

describe("system.media", () => {
  it("state: peak идёт из состояния ПК; pause в ТИШИНЕ не жмёт клавишу (иначе запустил бы музыку)", async () => {
    const k = makeKit();
    k.core.media = { playing: false, title: "Трек" };
    expect(await k.data({ kind: "system.media", op: "state" })).toEqual({ ok: true, playing: false, peak: 0 });
    expect(await k.data({ kind: "system.media", op: "pause" })).toEqual({ ok: true, playing: false, already: true, peak: 0 });
    expect(k.core.media.playing).toBe(false);
    expect(kinds(k, "system.media")).toEqual([{ op: "pause", pressed: false, reason: "silence", playing: false }]);
  });

  it("pause при звучащей музыке жмёт переключатель; play — тот же переключатель в ОБЕ стороны", async () => {
    const k = makeKit();
    k.core.media = { playing: true, title: "Трек" };
    expect(await k.data({ kind: "system.media", op: "state" })).toMatchObject({ playing: true, peak: 0.24 });
    await k.data({ kind: "system.media", op: "pause" });
    expect(k.core.media.playing).toBe(false);
    await k.data({ kind: "system.media", op: "play" });
    expect(k.core.media.playing).toBe(true);
    await k.data({ kind: "system.media", op: "play" }); // слепой переключатель: play при играющей музыке ставит паузу
    expect(k.core.media.playing).toBe(false);
    expect(kinds(k, "system.media").map((d) => [d.op, d.pressed, d.changed, d.playing])).toEqual([["pause", true, true, false], ["play", true, true, true], ["play", true, true, false]]);
  });

  it("тишина от mute/нулевой громкости = «не играет» даже при media.playing; stop не переключатель; без медиа-сессии клавиша вхолостую", async () => {
    const k = makeKit();
    k.core.media = { playing: true, title: "Трек" };
    k.core.muted = true;
    expect(await k.data({ kind: "system.media", op: "state" })).toMatchObject({ playing: false });
    expect(await k.data({ kind: "system.media", op: "pause" })).toMatchObject({ already: true });
    k.core.muted = false;
    await k.data({ kind: "system.media", op: "stop" });
    await k.data({ kind: "system.media", op: "stop" });
    expect(k.core.media.playing).toBe(false);
    const empty = makeKit();
    expect(await empty.data({ kind: "system.media", op: "play" })).toEqual({ ok: true });
    expect(empty.core.media.playing).toBe(false);
    expect(kinds(empty, "system.media")[0]).toMatchObject({ pressed: true, changed: false });
  });
});

describe("system.volume", () => {
  it("get/up/down шагом 10 с зажимом 0..100; readback = факт", async () => {
    const k = makeKit();
    k.core.volume = 40;
    expect(await k.data({ kind: "system.volume", op: "get" })).toEqual({ ok: true, level: 40 });
    expect(await k.data({ kind: "system.volume", op: "up" })).toEqual({ ok: true, level: 50 });
    k.core.volume = 95;
    expect(await k.data({ kind: "system.volume", op: "up" })).toEqual({ ok: true, level: 100 });
    k.core.volume = 5;
    expect(await k.data({ kind: "system.volume", op: "down" })).toEqual({ ok: true, level: 0 });
    expect(kinds(k, "system.volume").at(-1)).toMatchObject({ op: "down", from: 5, level: 0 });
  });

  it("set: без level → 50; за пределами 0..100 громкость зажимается и ЧЕСТНО падает ошибкой (допуск ±3); mute — тумблер", async () => {
    const k = makeKit();
    expect(await k.data({ kind: "system.volume", op: "set" })).toEqual({ ok: true, level: 50 });
    expect(await k.data({ kind: "system.volume", op: "set", level: 73.4 })).toEqual({ ok: true, level: 73 });
    expect(await k.data({ kind: "system.volume", op: "set", level: 102 })).toEqual({ ok: true, level: 100 }); // в допуске
    expect(await k.err({ kind: "system.volume", op: "set", level: 150 })).toBe("громкость не установилась: просил 150, по факту 100");
    expect(k.core.volume).toBe(100); // как у клиента: сначала выставлено, потом сверка
    expect(await k.err({ kind: "system.volume", op: "set", level: -20 })).toContain("по факту 0");
    expect(await k.data({ kind: "system.volume", op: "mute" })).toEqual({ ok: true, muted: true });
    expect(await k.data({ kind: "system.volume", op: "mute" })).toEqual({ ok: true, muted: false });
    await k.data({ kind: "system.volume", op: "mute" });
    expect(await k.data({ kind: "system.volume", op: "set", level: 30 })).toMatchObject({ level: 30 });
    expect(k.core.muted).toBe(true); // set mute не снимает
  });
});

describe("system.clipboard / system.layout", () => {
  it("write → read возвращают тот же текст (кириллица, переводы строк); пустой буфер читается как \"\"; эффект clipboard.write", async () => {
    const k = makeKit();
    expect(await k.data({ kind: "system.clipboard", op: "read" })).toEqual({ ok: true, stdout: "" });
    expect(await k.data({ kind: "system.clipboard", op: "write", text: "Привет\r\nмир" })).toEqual({ ok: true });
    expect(await k.data({ kind: "system.clipboard", op: "read" })).toEqual({ ok: true, stdout: "Привет\r\nмир" });
    expect(kinds(k, "clipboard.write")).toEqual([{ via: "system.clipboard", length: 11, text: "Привет\r\nмир" }]);
    await k.data({ kind: "system.clipboard", op: "write" });
    expect(k.core.clipboard).toBe("");
  });

  it("раскладка: по умолчанию ru, явная en/ru, toggle; состояние на ОКНО и сбрасывается reset()", async () => {
    const k = makeKit({ windows: [{ title: "A", process: "notepad" }, { title: "B", process: "chrome" }] });
    const [a, b] = [...k.core.windows.keys()] as [number, number];
    k.core.foreground = a;
    expect(await k.data({ kind: "system.layout", lang: "en" })).toEqual({ ok: true, stdout: "en" });
    expect(await k.data({ kind: "system.layout", lang: "toggle" })).toEqual({ ok: true, stdout: "ru" });
    expect(await k.data({ kind: "system.layout", lang: "toggle" })).toEqual({ ok: true, stdout: "en" });
    k.core.foreground = b;
    expect(await k.data({ kind: "system.layout", lang: "toggle" })).toEqual({ ok: true, stdout: "en" }); // у окна B своя история: ru → en
    expect(kinds(k, "system.layout")[0]).toMatchObject({ hwnd: a, from: "ru", to: "en", changed: true });
    k.core.reset();
    expect(await k.data({ kind: "system.layout", lang: "toggle" })).toEqual({ ok: true, stdout: "en" });
  });
});

describe("audio.sessions / audio.set", () => {
  const sessions = () => [
    { pid: 100, name: "chrome.exe", volume: 1, muted: false },
    { pid: 200, name: "spotify", volume: 0.5, muted: false },
    { pid: 300, name: "discord", volume: 0.8, muted: true },
  ];

  it("сессии: сортировка по пику, muted не звучит; в тишине все inactive с пиком 0", async () => {
    const k = makeKit();
    k.core.audioSessions = sessions();
    const quiet = await k.data<{ sessions: Array<{ state: string; peak: number }> }>({ kind: "audio.sessions" });
    expect(quiet.sessions.every((s) => s.state === "inactive" && s.peak === 0)).toBe(true);
    k.core.media = { playing: true };
    const loud = await k.data<{ sessions: Array<{ pid: number; process: string; state: string; muted: boolean; volume: number; peak: number; title: string }> }>({ kind: "audio.sessions" });
    expect(loud.sessions.map((s) => [s.pid, s.process, s.state])).toEqual([[100, "chrome", "active"], [200, "spotify", "active"], [300, "discord", "inactive"]]);
    expect(loud.sessions[0]).toEqual({ pid: 100, process: "chrome", title: "", state: "active", muted: false, volume: 1, peak: 0.5 });
  });

  it("audio.set: по process без регистра и .exe, по pid; mute + level (кламп 0..1); возвращает перечитанное состояние", async () => {
    const k = makeKit();
    k.core.audioSessions = sessions();
    const r = await k.data<{ touched: number; sessions: unknown[] }>({ kind: "audio.set", process: " CHROME.exe ", mute: true, level: 7 });
    expect(r).toEqual({ touched: 1, sessions: [{ pid: 100, process: "chrome", muted: true, volume: 1 }] });
    expect(k.core.audioSessions[0]).toMatchObject({ muted: true, volume: 1 });
    await k.data({ kind: "audio.set", pid: 200, mute: false, level: 0.25 });
    expect(k.core.audioSessions[1]).toMatchObject({ muted: false, volume: 0.25 });
    expect(kinds(k, "audio.set")).toHaveLength(2);
  });

  it("ошибки: нет цели, нечего менять, сессии нет («глушить нечего») — всё runtime, состояние не тронуто", async () => {
    const k = makeKit();
    k.core.audioSessions = sessions();
    expect(await k.err({ kind: "audio.set", mute: true })).toContain("не указано, какому приложению");
    expect(await k.err({ kind: "audio.set", process: "chrome" })).toContain("не указано, что менять");
    expect(await k.err({ kind: "audio.set", process: "steam", mute: true })).toBe("у «steam» нет активной звуковой сессии — глушить нечего (приложение молчит или закрыто)");
    expect(await k.err({ kind: "audio.set", pid: 999, mute: true })).toContain("pid 999");
    expect(k.core.audioSessions.map((s) => s.muted)).toEqual([false, false, true]);
    expect(kinds(k, "audio.set")).toEqual([]);
  });
});
