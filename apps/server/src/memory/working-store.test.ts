/**
 * Персист рабочей памяти (§5) — H9: flush-on-shutdown + атомарная запись (tmp→rename).
 *
 * Раньше не было flushWorkingStores (в отличие от flushTaskStores/flushResolutionStores) → рестарт
 * внутри 120мс debounce-окна терял только что состоявшийся ход; writeFileSync писал прямо в финальный
 * путь → kill посреди записи давал усечённый JSON и на boot вся дневная память сбрасывалась.
 *
 * DIR берётся из JARVIS_DATA_DIR (vitest.setup ставит изолированный temp) → пишем в тест-каталог.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dataPath } from "../paths.js";
import { flushWorkingStores, loadWorkingMemory } from "./working-store.js";

const MEM_DIR = dataPath("memory");
let uid = 0;
const uniqueUser = (): string => `flush-test-user-${process.pid}-${Date.now()}-${uid++}`;

describe("working-store — H9 flush + атомарная запись", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("flushWorkingStores() дописывает отложенный ход ДО debounce → свежая загрузка видит его", () => {
    const userId = uniqueUser();
    const mem = loadWorkingMemory(userId);
    mem.pushTurn("user", "привет джарвис"); // взводит debounce-сохранение (120мс), но таймер ещё не сработал
    // Файла ещё нет (debounce не истёк) — до фикса рестарт здесь потерял бы ход.
    flushWorkingStores(); // H9: синхронно дописать (как в gateway.close())
    const file = join(MEM_DIR, `${userId}.json`);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false); // атомарно: .tmp не осиротел

    // Свежая загрузка (в пределах TTL) видит реплику — память пережила бы рестарт.
    const reloaded = loadWorkingMemory(userId);
    expect(reloaded.recentTurns().some((t) => t.text === "привет джарвис")).toBe(true);
  });

  it("записанный JSON валиден и содержит savedAt (не усечён — tmp→rename)", () => {
    const userId = uniqueUser();
    const mem = loadWorkingMemory(userId);
    mem.pushTurn("assistant", "готово, сэр");
    flushWorkingStores();
    const file = join(MEM_DIR, `${userId}.json`);
    const raw = JSON.parse(readFileSync(file, "utf8")) as { savedAt?: number; turns?: unknown[] };
    expect(typeof raw.savedAt).toBe("number");
    expect(Array.isArray(raw.turns)).toBe(true);
  });

  it("flushWorkingStores() идемпотентен: повторный вызов без ожидающих записей — no-op, не бросает", () => {
    const userId = uniqueUser();
    const mem = loadWorkingMemory(userId);
    mem.pushTurn("user", "раз");
    flushWorkingStores();
    expect(() => flushWorkingStores()).not.toThrow(); // pendingSaves уже пуст
  });
});
