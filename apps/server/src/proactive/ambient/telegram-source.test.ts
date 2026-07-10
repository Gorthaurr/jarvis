import { describe, expect, it } from "vitest";
import { createTelegramSource, unreadSignal } from "./telegram-source.js";
import type { TelegramUnreadReader, UnreadResult } from "./telegram-source.js";

describe("Telegram ambient-источник — непрочитанные → сигналы", () => {
  it("unreadSignal: обычный 0.7, важный контакт 0.85, заглушённый 0.3; ключ по отправителю+тексту; «N новых»", () => {
    const now = 1000;
    const normal = unreadSignal({ title: "Аня", count: 1, preview: "привет" }, "u1", now, [])!;
    expect(normal.salience).toBeCloseTo(0.7);
    expect(normal.title).toContain("Аня");
    expect(normal.title).toContain("привет");

    const important = unreadSignal({ title: "Герман", count: 3, preview: "срочно позвони" }, "u1", now, ["герман"])!;
    expect(important.salience).toBeCloseTo(0.85); // важный контакт перебивает
    expect(important.title).toContain("3 новых");

    const muted = unreadSignal({ title: "Спам-канал", count: 5, muted: true }, "u1", now, [])!;
    expect(muted.salience).toBeCloseTo(0.3); // заглушён → ниже дефолтного порога 0.5 (движок отфильтрует)

    // пустой/нулевой → null
    expect(unreadSignal({ title: "", count: 1 }, "u1", now, [])).toBeNull();
    expect(unreadSignal({ title: "X", count: 0 }, "u1", now, [])).toBeNull();

    // новый текст → новый ключ (новое уведомление); тот же текст → тот же ключ (дедуп)
    const a = unreadSignal({ title: "Аня", count: 1, preview: "сообщение один" }, "u1", now, [])!;
    const b = unreadSignal({ title: "Аня", count: 2, preview: "сообщение два" }, "u1", now, [])!;
    expect(a.key).not.toBe(b.key);
  });

  it("источник poll: нет вкладки → []; список непрочитанных → сигналы; ошибка ридера → []", async () => {
    let result: UnreadResult = { ok: true, noTab: true };
    const reader: TelegramUnreadReader = { telegramUnread: async () => result };
    const src = createTelegramSource(reader, "u1", { importantContacts: () => ["герман"] });

    expect(await src.poll()).toEqual([]); // нет открытой вкладки → не лезем

    result = { ok: true, unread: [{ title: "Герман", count: 2, preview: "тут?" }, { title: "Аня", count: 1 }] };
    const sigs = await src.poll();
    expect(sigs).toHaveLength(2);
    expect(sigs.find((s) => s.title.includes("Герман"))?.salience).toBeCloseTo(0.85);

    const throwing: TelegramUnreadReader = { telegramUnread: async () => { throw new Error("расширение не подключено"); } };
    expect(await createTelegramSource(throwing, "u1").poll()).toEqual([]); // ошибка → пусто, не падаем
  });
});
