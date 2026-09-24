/**
 * W0: клиентский §14-рубеж на путях, минующих серверный dispatchTool (SDK-мост, реплей навыка).
 * Реверт-проверка: сними вызов assessClientCommit в guardedDispatch — «Enter в Telegram через мост»
 * упадёт (dispatch будет вызван).
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { assertActCommitAllowed, assertReplayCommitAllowed, assertReplayTypeAllowed, assessClientCommit, guardedDispatch } from "./commit-guard.js";

const ok = (commandId: string): ActionResult => ({ commandId, ok: true, durationMs: 1 });

describe("assessClientCommit — чистая политика", () => {
  it("Enter / Ctrl+Enter в мессенджере или банке — отказ", () => {
    for (const proc of ["Telegram.exe", "discord", "WhatsApp", "1cv8", "sbbol"]) {
      expect(assessClientCommit({ kind: "input.key", combo: "Enter" }, proc, "bridge"), proc).not.toBeNull();
      expect(assessClientCommit({ kind: "input.key", combo: "ctrl+enter" }, proc, "replay"), proc).not.toBeNull();
    }
  });

  it("Enter в обычной программе, не-Enter в мессенджере, отпускание клавиши, другие команды — пропуск", () => {
    expect(assessClientCommit({ kind: "input.key", combo: "Enter" }, "notepad", "bridge")).toBeNull();
    expect(assessClientCommit({ kind: "input.key", combo: "Enter" }, "chrome", "bridge")).toBeNull();
    expect(assessClientCommit({ kind: "input.key", combo: "ctrl+s" }, "Telegram", "bridge")).toBeNull();
    expect(assessClientCommit({ kind: "input.key", combo: "Enter", mode: "up" }, "Telegram", "bridge")).toBeNull();
    expect(assessClientCommit({ kind: "input.type", text: "привет" }, "Telegram", "bridge")).toBeNull();
    expect(assessClientCommit({ kind: "input.key", combo: "Enter" }, null, "bridge")).toBeNull(); // передний план неизвестен
  });

  it("текст отказа называет процесс и штатный путь (input_key с подтверждением)", () => {
    const d = assessClientCommit({ kind: "input.key", combo: "Enter" }, "Telegram", "bridge")!;
    expect(d.message).toContain("Telegram");
    expect(d.message).toContain("input_key");
  });
});

describe("guardedDispatch — обёртка SDK-моста", () => {
  it("Enter при Telegram на переднем плане → отказ БЕЗ вызова dispatch", async () => {
    const dispatch = vi.fn(async (id: string, _c: ActionCommand) => ok(id));
    const g = guardedDispatch(dispatch, async () => "Telegram");
    const r = await g("c1", { kind: "input.key", combo: "Enter" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("denied");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("Enter в блокноте и любые другие команды проходят в dispatch как есть", async () => {
    const dispatch = vi.fn(async (id: string, _c: ActionCommand) => ok(id));
    const g = guardedDispatch(dispatch, async () => "notepad");
    await g("c1", { kind: "input.key", combo: "Enter" });
    await g("c2", { kind: "input.type", text: "x" });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("передний план неизвестен (сайдкар лёг) → пропуск, как у серверного гейта", async () => {
    const dispatch = vi.fn(async (id: string, _c: ActionCommand) => ok(id));
    const g = guardedDispatch(dispatch, async () => null);
    await g("c1", { kind: "input.key", combo: "Enter" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("assertReplayCommitAllowed — реплей навыка", () => {
  it("бросает на Enter в Discord и молчит на Enter в блокноте", async () => {
    await expect(assertReplayCommitAllowed("Enter", undefined, async () => "Discord")).rejects.toThrow(/§14/u);
    await expect(assertReplayCommitAllowed("Enter", undefined, async () => "notepad")).resolves.toBeUndefined();
  });
});

describe("W4 act — клиентский рубеж (SDK-мост / реплей)", () => {
  it("do:key Enter и клик по «Отправить»/«Оплатить» в рискованном процессе — отказ; печать, «Настройки», блокнот — пропуск", () => {
    expect(assessClientCommit({ kind: "gui.act", do: "key", combo: "Enter" }, "Telegram", "bridge")).not.toBeNull();
    expect(assessClientCommit({ kind: "gui.act", target: "Отправить" }, "discord", "bridge")?.message).toMatch(/клик «Отправить»/u);
    expect(assessClientCommit({ kind: "gui.act", target: { text: "Оплатить" }, do: "double" }, "sbbol", "replay")).not.toBeNull();
    expect(assessClientCommit({ kind: "gui.act", target: "Отправить", do: "type", text: "x" }, "Telegram", "bridge")).toBeNull();
    expect(assessClientCommit({ kind: "gui.act", target: "Настройки" }, "Telegram", "bridge")).toBeNull();
    expect(assessClientCommit({ kind: "gui.act", target: "Отправить" }, "notepad", "bridge")).toBeNull();
    // H-S1 (ревью 2026-09-24): act с app судится по программе в app — Chrome спереди не прикрывает отправку в Telegram.
    expect(assessClientCommit({ kind: "gui.act", target: "Отправить", app: "Telegram" }, "chrome", "bridge")).not.toBeNull();
    expect(assessClientCommit({ kind: "gui.act", target: "Отправить", app: "notepad" }, "Telegram", "bridge")).toBeNull();
    // Контроль-1 №1 (ревью 2026-09-24): имя в app — нестрого («дискорд», «Telegram Desktop»).
    expect(assessClientCommit({ kind: "gui.act", do: "key", combo: "Enter", app: "дискорд" }, "chrome", "bridge")).not.toBeNull();
    expect(assessClientCommit({ kind: "gui.act", target: "Отправить", app: "Telegram Desktop" }, "chrome", "replay")).not.toBeNull();
  });

  // Ревью 2026-09-24: перевод строки в печатаемом тексте = Enter — мессенджер отправит без вопроса владельцу.
  it("печать с \\n/\\r в мессенджере (input.type и act do:type) — отказ; в блокноте и без перевода строки — пропуск", () => {
    expect(assessClientCommit({ kind: "input.type", text: "буду в семь\n" }, "Telegram", "bridge")?.message).toMatch(/перевод/u);
    expect(assessClientCommit({ kind: "gui.act", do: "type", target: "Сообщение", text: "ок\r" }, "discord", "replay")).not.toBeNull();
    expect(assessClientCommit({ kind: "input.type", text: "строка 1\nстрока 2" }, "notepad", "bridge")).toBeNull();
    expect(assessClientCommit({ kind: "gui.act", do: "type", target: "Сообщение", text: "ок" }, "Telegram", "bridge")).toBeNull();
  });

  // Контроль-2 №3: мост пропускал input.type мимо гейта — jarvis.write("привет\n") уходил в Telegram без вопроса.
  // Реверт: убери input.type из условия guardedDispatch — dispatch будет вызван.
  it("guardedDispatch: печать с переводом строки через мост при Telegram → denied; без перевода — проходит", async () => {
    const dispatch = vi.fn(async (id: string, _c: ActionCommand) => ok(id));
    const g = guardedDispatch(dispatch, async () => "Telegram");
    const r = await g("c1", { kind: "input.type", text: "привет\n" });
    expect(r.error?.code).toBe("denied");
    expect(dispatch).not.toHaveBeenCalled();
    await g("c2", { kind: "input.type", text: "привет" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  // Контроль-2: в почтовом клиенте перевод строки — абзац письма, а не отправка. Реверт: убери исключение для «почта».
  it("почта: многострочная печать через мост/реплей не считается отправкой", () => {
    expect(assessClientCommit({ kind: "input.type", text: "Добрый день,\nспасибо" }, "outlook", "bridge")).toBeNull();
    expect(assessClientCommit({ kind: "input.key", combo: "Enter" }, "outlook", "bridge")).not.toBeNull();
  });

  it("реплей: шаг input.type с переводом строки в мессенджере — отказ; в блокноте — нет", async () => {
    await expect(assertReplayTypeAllowed("ок\r\n", async () => "discord")).rejects.toThrow(/§14/u);
    await expect(assertReplayTypeAllowed("строка 1\nстрока 2", async () => "notepad")).resolves.toBeUndefined();
  });

  // Контроль-2 №4: act{app:"tele"} фокусирует Telegram, а сервер по подстроке программу не узнал — клиент судит по
  // РЕАЛЬНО сфокусированному процессу. Реверт: return в начале assertActCommitAllowed — первый ассерт не бросит.
  it("act-коммит без подтверждения сервера в реально сфокусированном мессенджере — отказ; одобренный/не коммит/блокнот — нет", async () => {
    const enter = { kind: "gui.act", app: "tele", do: "key", combo: "Enter" } as ActionCommand;
    await expect(assertActCommitAllowed(enter, async () => "Telegram")).rejects.toThrow(/Ничего не нажато.*app: «Telegram»/u);
    await expect(assertActCommitAllowed({ ...enter, commitApproved: true } as ActionCommand, async () => "Telegram")).resolves.toBeUndefined();
    await expect(assertActCommitAllowed({ kind: "gui.act", app: "tele", target: "Настройки" } as ActionCommand, async () => "Telegram")).resolves.toBeUndefined();
    await expect(assertActCommitAllowed(enter, async () => "notepad")).resolves.toBeUndefined();
    await expect(assertActCommitAllowed({ kind: "gui.act", app: "general", target: "Отправить" } as ActionCommand, async () => "Discord")).rejects.toThrow(/§14/u);
  });

  it("guardedDispatch: act «Отправить» при Telegram → denied без dispatch; act «Настройки» проходит", async () => {
    const dispatch = vi.fn(async (id: string, _c: ActionCommand) => ok(id));
    const g = guardedDispatch(dispatch, async () => "Telegram");
    const r = await g("c1", { kind: "gui.act", target: "Отправить" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("denied");
    expect(dispatch).not.toHaveBeenCalled();
    await g("c2", { kind: "gui.act", target: "Настройки" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
