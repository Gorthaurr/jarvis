/**
 * Контроль-1 №6 (ревью 2026-09-24): вставка через буфер не должна терять буфер владельца.
 * Реверт: верни `const prev = clipboard.readText()` / `writeText(prev)` — первый тест упадёт (картинка стёрта),
 * убери проверку форматов — второй (скопированные файлы подменены текстом).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const clip = {
  formats: [] as string[],
  text: "",
  html: "",
  rtf: "",
  image: { isEmpty: () => true } as { isEmpty: () => boolean },
  writes: [] as unknown[],
  cleared: 0,
};
vi.mock("electron", () => ({
  clipboard: {
    availableFormats: () => clip.formats,
    readText: () => clip.text,
    readHTML: () => clip.html,
    readRTF: () => clip.rtf,
    readImage: () => clip.image,
    writeText: (t: string) => clip.writes.push({ text: t }),
    write: (d: unknown) => clip.writes.push(d),
    clear: () => {
      clip.cleared += 1;
    },
  },
}));
const pressKey = vi.fn(async (_c: string) => undefined);
const typeText = vi.fn(async (_t: string) => undefined);
vi.mock("./input.js", () => ({ pressKey: (c: string) => pressKey(c), typeText: (t: string) => typeText(t) }));

const { pasteText } = await import("./paste-text.js");

beforeEach(() => {
  clip.formats = [];
  clip.text = "";
  clip.html = "";
  clip.rtf = "";
  clip.image = { isEmpty: () => true };
  clip.writes = [];
  clip.cleared = 0;
  pressKey.mockClear();
  typeText.mockClear();
  vi.useFakeTimers();
});

describe("pasteText — буфер владельца", () => {
  it("в буфере скриншот → после вставки картинка возвращена (а не пустая строка)", async () => {
    const shot = { isEmpty: () => false, tag: "screenshot" };
    clip.formats = ["image/png"];
    clip.image = shot;
    const p = pasteText("длинный текст");
    await vi.runAllTimersAsync();
    expect(await p).toBe("paste");
    expect(pressKey).toHaveBeenCalledWith("Ctrl+V");
    expect(clip.writes.at(-1)).toEqual({ image: shot });
    vi.useRealTimers();
  });

  it("в буфере скопированные файлы (вернуть нельзя) → буфер не трогаем, печатаем посимвольно", async () => {
    clip.formats = ["text/uri-list", "Files"];
    const p = pasteText("длинный текст");
    await vi.runAllTimersAsync();
    expect(await p).toBe("type");
    expect(typeText).toHaveBeenCalledWith("длинный текст");
    expect(pressKey).not.toHaveBeenCalled();
    expect(clip.writes).toHaveLength(0);
    vi.useRealTimers();
  });

  it("текст+HTML возвращаются оба; буфер возвращается не раньше, чем через PASTE_SETTLE_MS", async () => {
    clip.formats = ["text/plain", "text/html"];
    clip.text = "мой пароль";
    clip.html = "<b>мой пароль</b>";
    const p = pasteText("сообщение");
    await vi.advanceTimersByTimeAsync(150);
    expect(clip.writes).toEqual([{ text: "сообщение" }]); // 150 мс — ещё не вернули (прежняя гонка)
    await vi.runAllTimersAsync();
    await p;
    expect(clip.writes.at(-1)).toEqual({ text: "мой пароль", html: "<b>мой пароль</b>" });
    vi.useRealTimers();
  });
});
