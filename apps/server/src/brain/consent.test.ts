/**
 * Персистентное согласие на отправку (§14): спросить раз — помнить навсегда (между сессиями).
 * fs замокан — тест не пишет на диск; проверяем нормализацию ключа и approve/revoke в памяти.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
  readFile: vi.fn(async () => {
    throw new Error("ENOENT");
  }),
}));

import {
  _resetConsentForTest,
  approveSend,
  consentKey,
  isSendApproved,
  listConsents,
  revokeSend,
  revokeSendMatching,
} from "./consent.js";

beforeEach(() => _resetConsentForTest());

describe("consent (§14 персистентное согласие на отправку)", () => {
  it("consentKey нормализует адресата (регистр/пробелы) и разделяет userId/канал", () => {
    expect(consentKey("u1", "telegram", "  Катя ")).toBe("u1:telegram:катя");
    expect(consentKey("u1", "telegram", "КАТЯ")).toBe(consentKey("u1", "telegram", "катя"));
    expect(consentKey("u1", "telegram", "Катя")).not.toBe(consentKey("u2", "telegram", "Катя"));
  });

  it("до одобрения — нет; после approveSend — помнит (в т.ч. иной регистр)", async () => {
    expect(isSendApproved("u1", "telegram", "Катя")).toBe(false);
    await approveSend("u1", "telegram", "Катя");
    expect(isSendApproved("u1", "telegram", "Катя")).toBe(true);
    expect(isSendApproved("u1", "telegram", "  катя ")).toBe(true); // нормализация
    expect(isSendApproved("u1", "telegram", "Маша")).toBe(false); // другой адресат
    expect(isSendApproved("u1", "vk", "Катя")).toBe(false); // другой канал
    expect(isSendApproved("u2", "telegram", "Катя")).toBe(false); // другой пользователь
  });

  it("revokeSend отзывает согласие («больше не шли X»)", async () => {
    await approveSend("u1", "telegram", "Катя");
    expect(await revokeSend("u1", "telegram", "Катя")).toBe(true);
    expect(isSendApproved("u1", "telegram", "Катя")).toBe(false);
    expect(await revokeSend("u1", "telegram", "Катя")).toBe(false); // уже нечего отзывать
  });

  // F4 (волна F): инспекция согласий — consent.json перестаёт быть невидимым.
  it("listConsents: только свои, канал/адресат разобраны, свежие первыми", async () => {
    await approveSend("u1", "telegram", "Катя");
    await approveSend("u1", "vk", "Маша");
    await approveSend("u2", "telegram", "Чужой");
    const mine = listConsents("u1");
    expect(mine).toHaveLength(2); // чужого пользователя нет
    expect(mine.map((c) => `${c.channel}:${c.recipient}`).sort()).toEqual(["telegram:катя", "vk:маша"]);
    for (const c of mine) expect(c.ts).toBeTypeOf("number");
    await revokeSend("u1", "vk", "Маша");
    expect(listConsents("u1").map((c) => c.recipient)).toEqual(["катя"]); // отзыв виден в инспекции
  });

  // 🔴 Контроль волны F (HIGH): согласия на ОДНОГО человека копятся под разными написаниями (модель
  // называет контакт в разных падежах) — точечный отзыв снимал одно, а владельцу обещали «снова
  // спросит подтверждения»: назавтра отправка уходила БЕЗ спроса через оставшийся ключ.
  it("revokeSendMatching снимает ВСЕ написания адресата (склонения) и возвращает снятое", async () => {
    await approveSend("u1", "telegram", "Катя");
    await approveSend("u1", "telegram", "Кате");
    await approveSend("u1", "telegram", "Катю");
    await approveSend("u1", "telegram", "Маша"); // другой человек — не трогаем
    await approveSend("u1", "vk", "Катя"); // другой канал — не трогаем
    const removed = await revokeSendMatching("u1", "telegram", "Кате");
    expect(removed.sort()).toEqual(["катю", "катя", "кате"].sort());
    expect(isSendApproved("u1", "telegram", "Катя")).toBe(false); // гейт реально взведён обратно
    expect(isSendApproved("u1", "telegram", "Кате")).toBe(false);
    expect(isSendApproved("u1", "telegram", "Маша")).toBe(true); // сосед не задет
    expect(isSendApproved("u1", "vk", "Катя")).toBe(true); // другой канал не задет
  });

  it("revokeSendMatching: нечего отзывать → пустой список (вызывающий скажет честно)", async () => {
    expect(await revokeSendMatching("u1", "telegram", "Никто")).toEqual([]);
  });

  // 🔴 Контроль-2 (HIGH ×2): стем считался от ВСЕЙ строки и без foldName — полное имя из
  // namesake-выбора («Катя Любимая») и ё/е-написание не снимались, а владельцу обещали взведённый гейт.
  it("снимает ПОЛНОЕ имя (namesake), ё/е и украшения — потокенно и через foldName", async () => {
    await approveSend("u1", "telegram", "Катя");
    await approveSend("u1", "telegram", "Катя Любимая");
    expect((await revokeSendMatching("u1", "telegram", "Катя")).length).toBe(2);
    expect(isSendApproved("u1", "telegram", "Катя Любимая")).toBe(false);

    await approveSend("u1", "telegram", "Алёна");
    await approveSend("u1", "telegram", "Алене");
    expect((await revokeSendMatching("u1", "telegram", "Алены")).length).toBe(2); // ё/е сведены
    expect(isSendApproved("u1", "telegram", "Алёна")).toBe(false);

    await approveSend("u1", "telegram", "Катя 💜");
    await approveSend("u1", "telegram", "Кате");
    expect((await revokeSendMatching("u1", "telegram", "Катя")).length).toBe(2); // украшения не мешают
    expect(isSendApproved("u1", "telegram", "Катя 💜")).toBe(false);
  });

  it("разные люди не сливаются: соседи и короткие имена целы", async () => {
    await approveSend("u1", "telegram", "Оля");
    await approveSend("u1", "telegram", "Олег");
    await approveSend("u1", "telegram", "Ян");
    await approveSend("u1", "telegram", "Яна");
    expect(await revokeSendMatching("u1", "telegram", "Оля")).toEqual(["оля"]);
    expect(isSendApproved("u1", "telegram", "Олег")).toBe(true);
    expect(await revokeSendMatching("u1", "telegram", "Ян")).toEqual(["ян"]);
    expect(isSendApproved("u1", "telegram", "Яна")).toBe(true);
  });
});
