/**
 * 🔴 «СЕКРЕТ ОТКРЫТЫМ НЕ ПИШЕМ» — ПРОВЕРКА САМОЙ ВЕТКИ (аудит тестовой базы 2026-09-01).
 *
 * В credentials.test.ts есть тест с именем «без мастер-ключа setCredential ЧЕСТНО не сохраняет», но
 * его тело утверждает ПРОТИВОПОЛОЖНОЕ (`toBe(true)`): ключ самобутстрапится, поэтому дойти до ветки
 * отказа тем путём невозможно. Имя обещало гард, которого тест не касался, а сама ветка
 * `if (!blob) return false` не была покрыта нигде — притом что она и есть обещание модуля:
 * шифровать нечем — не сохраняем вовсе, а не пишем секрет открытым текстом.
 *
 * Здесь шифрование подменено на недоступное, и проверяется наблюдаемое: возврат false и НИ ОДНОГО
 * обращения к базе (иначе секрет уехал бы в таблицу).
 */
import { describe, expect, it, vi } from "vitest";

const queryCalls: unknown[][] = [];
const crypto = { available: true };

vi.mock("./crypto.js", () => ({
  // Недоступный мастер-ключ: encryptSecret возвращает null — ровно как при отсутствии ключа.
  encryptSecret: (v: string) => (crypto.available ? Buffer.from(`enc:${v}`) : null),
  decryptSecret: (b: Buffer) => String(b).replace(/^enc:/, ""),
}));

vi.mock("./pool.js", () => ({
  query: vi.fn(async (...args: unknown[]) => {
    queryCalls.push(args);
    return { rows: [] };
  }),
}));

const { setCredential } = await import("./credentials.js");

describe("нет мастер-ключа — секрет не сохраняется вовсе", () => {
  it("возвращает false и НЕ трогает базу (открытым текстом не пишем)", async () => {
    crypto.available = false;
    queryCalls.length = 0;

    const ok = await setCredential("u1", "openai", "sk-очень-секретный");

    expect(ok).toBe(false);
    expect(queryCalls).toHaveLength(0); // ← главное: до insert дело не дошло
  });

  it("секрет не утекает в аргументы запроса даже при попытке сохранить", async () => {
    crypto.available = false;
    queryCalls.length = 0;
    await setCredential("u1", "anthropic", "sk-ant-секрет");
    expect(JSON.stringify(queryCalls)).not.toContain("sk-ant-секрет");
  });

  it("с доступным ключом сохранение идёт — гард не парализует работу", async () => {
    crypto.available = true;
    queryCalls.length = 0;

    const ok = await setCredential("u1", "openai", "sk-рабочий");

    expect(ok).toBe(true);
    expect(queryCalls).toHaveLength(1);
    // В базу уходит ШИФРОТЕКСТ, а не исходное значение.
    expect(JSON.stringify(queryCalls[0])).not.toContain("sk-рабочий");
  });

  it("пустые аргументы отсекаются до шифрования и до базы", async () => {
    crypto.available = true;
    queryCalls.length = 0;
    expect(await setCredential("", "openai", "k")).toBe(false);
    expect(await setCredential("u1", "", "k")).toBe(false);
    expect(await setCredential("u1", "openai", "   ")).toBe(false);
    expect(queryCalls).toHaveLength(0);
  });
});
