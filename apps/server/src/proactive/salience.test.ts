/**
 * ⚠️ ЧЕСТНО О ГРАНИЦАХ ЭТОГО ФАЙЛА (аудит тестовой базы 2026-09-01).
 *
 * `shouldInterrupt` и `NudgeQueue` в рантайме НЕ ЗОВЁТСЯ НИКЕМ — это задел проактивного слоя (§9),
 * его единственный потребитель `hub.ts` тоже не подключён. Тесты ниже фиксируют КОНТРАКТ на будущее
 * и не защищают ни один работающий путь: держим их именно с этой оговоркой, чтобы зелёный прогон
 * не читался как «проактивный слой проверен».
 *
 * Из рантайма модуля живут только `noteClientContext`/`forgetClientContext` (router-ws и server), но
 * накопленный ими контекст в текущем коде НИКТО НЕ ЧИТАЕТ — это накопитель без потребителя, а не
 * механизм; тестировать в нём нечего, кроме отсутствия утечки, а для этого нужен геттер, которого
 * нет. Появится потребитель — тест писать вместе с ним и против реальной проводки.
 *
 * Удалено отсюда: проверка `isExpired` — тавтология на однострочном `expiresAt < now`.
 */
import { describe, expect, it } from "vitest";
import type { ClientContext } from "@jarvis/protocol";
import { NudgeQueue, shouldInterrupt } from "./salience.js";
import type { Trigger } from "./triggers/index.js";

const ctxFree: ClientContext = { activeApp: "explorer", fullscreen: false, micBusyByOtherApp: false, locked: false };
const trig = (over: Partial<Trigger> = {}): Trigger => ({
  id: "t1",
  kind: "time",
  importance: 0.5,
  hint: "напоминание",
  expiresAt: 10_000,
  userId: "u1",
  ...over,
});

describe("shouldInterrupt (§9)", () => {
  it("свободный контекст + достаточная важность → прерываем", () => {
    expect(shouldInterrupt(ctxFree, trig()).interrupt).toBe(true);
  });
  it("звонок (микрофон занят) → не прерываем", () => {
    expect(shouldInterrupt({ ...ctxFree, micBusyByOtherApp: true }, trig()).interrupt).toBe(false);
  });
  it("заблокированный экран → не прерываем", () => {
    expect(shouldInterrupt({ ...ctxFree, locked: true }, trig()).interrupt).toBe(false);
  });
  it("fullscreen режет обычное, но критическое пробивает", () => {
    expect(shouldInterrupt({ ...ctxFree, fullscreen: true }, trig({ importance: 0.5 })).interrupt).toBe(false);
    expect(shouldInterrupt({ ...ctxFree, fullscreen: true }, trig({ importance: 0.97 })).interrupt).toBe(true);
  });
  it("DND подавляет голос (доставка пушем)", () => {
    expect(shouldInterrupt(ctxFree, trig({ importance: 0.9 }), { dnd: true }).interrupt).toBe(false);
  });
  it("низкая важность → ниже порога", () => {
    expect(shouldInterrupt(ctxFree, trig({ importance: 0.1 })).interrupt).toBe(false);
  });
});

describe("NudgeQueue (§9: копить при занятости, отбрасывать истёкшее)", () => {
  it("flush отдаёт не истёкшие и чистит очередь", () => {
    const q = new NudgeQueue();
    q.enqueue(trig({ id: "a", expiresAt: 5_000 }));
    q.enqueue(trig({ id: "b", expiresAt: 1_000 })); // истечёт к now=2000
    const out = q.flush("u1", 2_000);
    expect(out.map((t) => t.id)).toEqual(["a"]);
    expect(q.size("u1")).toBe(0);
  });
});
