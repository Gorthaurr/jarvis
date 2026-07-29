/**
 * §Волна3 ревью (#12) — валидация предиката на постановке watch_create: мёртвый предикат (опечатка в
 * kind / gsi без path / отсутствующие обязательные поля) НЕ принимается «в тишину» (иначе наблюдение
 * тикало бы вечно, а уведомление было бы невозможно — ложный успех постановки).
 */
import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../dispatch.js";
import { watchCreate } from "./watch.js";

type AddInput = Record<string, unknown>;
const okAdd = () => vi.fn((_input: AddInput) => ({ ok: true, watch: { id: "w1", what: "x", condition: "y", intervalMs: 10_000, continuous: false } }));

function ctxWith(add: ReturnType<typeof okAdd> = okAdd()) {
  return { watch: { add } as unknown, sessionId: "s1", userId: "u1" } as unknown as ToolContext;
}

const base = { what: "матч в доте", condition: "матч найден" };

describe("watchCreate — валидация предиката (§Волна3 ревью #12)", () => {
  it("валидный gsi-предикат принимается и уходит в add", async () => {
    const add = okAdd();
    const res = await watchCreate(ctxWith(add), { ...base, predicate: { kind: "gsi", path: "map.game_state", contains: "IN_PROGRESS" } });
    expect(res.isError).toBeFalsy();
    expect(add).toHaveBeenCalledTimes(1);
    expect((add.mock.calls[0]![0] as { predicate?: unknown }).predicate).toMatchObject({ kind: "gsi" });
  });

  it("опечатка в kind → честная ошибка, add НЕ зовётся", async () => {
    const add = okAdd();
    const res = await watchCreate(ctxWith(add), { ...base, predicate: { kind: "windows", titleContains: "Принять" } });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/неизвестный kind/i);
    expect(add).not.toHaveBeenCalled();
  });

  it("gsi без path → честная ошибка (иначе клиент вечно met:false)", async () => {
    const add = okAdd();
    const res = await watchCreate(ctxWith(add), { ...base, predicate: { kind: "gsi" } });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/path/i);
    expect(add).not.toHaveBeenCalled();
  });

  it("window без titleContains/process → честная ошибка", async () => {
    const add = okAdd();
    const res = await watchCreate(ctxWith(add), { ...base, predicate: { kind: "window" } });
    expect(res.isError).toBe(true);
    expect(add).not.toHaveBeenCalled();
  });

  it("без предиката (веб/LLM-наблюдение) — по-прежнему принимается", async () => {
    const add = okAdd();
    const res = await watchCreate(ctxWith(add), { ...base });
    expect(res.isError).toBeFalsy();
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("(fix 2026-07-15) валидный browser-предикат (video.currentTime) принимается", async () => {
    const add = okAdd();
    const res = await watchCreate(ctxWith(add), { ...base, predicate: { kind: "browser", prop: "currentTime", op: ">=", value: 1560 } });
    expect(res.isError).toBeFalsy();
    expect((add.mock.calls[0]![0] as { predicate?: unknown }).predicate).toMatchObject({ kind: "browser", value: 1560 });
  });

  it("(fix 2026-07-15) browser без value → честная ошибка (иначе мёртвый предикат)", async () => {
    const add = okAdd();
    const res = await watchCreate(ctxWith(add), { ...base, predicate: { kind: "browser", prop: "currentTime", op: ">=" } });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/value/i);
    expect(add).not.toHaveBeenCalled();
  });

  it("(fix 2026-07-15) browser с кривым op → честная ошибка", async () => {
    const add = okAdd();
    const res = await watchCreate(ctxWith(add), { ...base, predicate: { kind: "browser", value: 1560, op: "≥" } });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/op/i);
    expect(add).not.toHaveBeenCalled();
  });

  // Ревью фиксов Волны 3 (#9): типы критерия gsi. Клиент сравнивает String(value) со СТРОКОЙ —
  // boolean/number-критерий без коэрции давал «принят, но не сработает никогда» (тот же класс #12).
  it("(#9) gsi equals:true (boolean) коэрсится в строку «true» — предикат живой", async () => {
    const add = okAdd();
    const res = await watchCreate(ctxWith(add), { ...base, predicate: { kind: "gsi", path: "map.paused", equals: true } });
    expect(res.isError).toBeFalsy();
    expect((add.mock.calls[0]![0] as { predicate?: { equals?: unknown } }).predicate?.equals).toBe("true");
  });

  it("(#9) gsi contains:5 (number) коэрсится в «5»; объект в equals — честный отказ", async () => {
    const add = okAdd();
    const res = await watchCreate(ctxWith(add), { ...base, predicate: { kind: "gsi", path: "hero.level", contains: 5 } });
    expect(res.isError).toBeFalsy();
    expect((add.mock.calls[0]![0] as { predicate?: { contains?: unknown } }).predicate?.contains).toBe("5");

    const add2 = okAdd();
    const res2 = await watchCreate(ctxWith(add2), { ...base, predicate: { kind: "gsi", path: "x", equals: { deep: 1 } } });
    expect(res2.isError).toBe(true);
    expect(add2).not.toHaveBeenCalled();
  });

  it("(#9) gone не-булев («true» строкой) — честный отказ на постановке (полумёртвый предикат)", async () => {
    const add = okAdd();
    const res = await watchCreate(ctxWith(add), { ...base, predicate: { kind: "gsi", path: "map.game_state", gone: "true" } });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/gone/i);
    expect(add).not.toHaveBeenCalled();
  });
});

// §14 (адверс-ревью 2026-07-28 [10]): наблюдение с action = отложенное действие от имени владельца →
// подтверждение на ПОСТАНОВКЕ (иначе prompt-инъекция «отмывалась» бы в доверенное поручение).
describe("watchCreate — confirm на постановке action", () => {
  it("action без канала confirm → fail-closed отказ, add не зовётся", async () => {
    const add = okAdd();
    const res = await watchCreate(ctxWith(add), { ...base, action: "напиши Кате" });
    expect(res.isError).toBe(true);
    expect(add).not.toHaveBeenCalled();
  });

  it("отказ владельца → не ставим; approve → ставим с action", async () => {
    const add = okAdd();
    const deny = { ...(ctxWith(add) as object), confirm: async () => ({ approved: false }) } as unknown as ToolContext;
    const res = await watchCreate(deny, { ...base, action: "напиши Кате" });
    expect(res.isError).toBe(true);
    expect(add).not.toHaveBeenCalled();

    const add2 = okAdd();
    const allow = { ...(ctxWith(add2) as object), confirm: async () => ({ approved: true }) } as unknown as ToolContext;
    const res2 = await watchCreate(allow, { ...base, action: "напиши Кате" });
    expect(res2.isError).toBeFalsy();
    expect((add2.mock.calls[0]![0] as { action?: string }).action).toBe("напиши Кате");
  });
});
