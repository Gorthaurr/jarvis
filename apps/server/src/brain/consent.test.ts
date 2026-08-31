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

import { _resetConsentForTest, approveSend, consentKey, isSendApproved, listConsents, revokeSend } from "./consent.js";

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
});
