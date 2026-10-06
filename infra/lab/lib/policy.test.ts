import { describe, expect, it } from "vitest";
import { answerOf, createConfirmRunner, parseConfirmPolicy, toConfirmResult } from "./policy.js";

describe("политика подтверждений §14", () => {
  it("по умолчанию отказ: необратимое само не подтверждается", () => {
    const r = createConfirmRunner();
    expect(r.decide("отправить?", "send").answer).toBe("no");
  });

  it("массив выдаётся по очереди, а когда кончился — «no» с пометкой overflow (не «yes»)", () => {
    const r = createConfirmRunner(["yes", "expire"]);
    expect(r.decide("a", "send")).toMatchObject({ n: 1, answer: "yes" });
    expect(r.decide("b", "order")).toMatchObject({ n: 2, answer: "expire" });
    const third = r.decide("c", "irreversible");
    expect(third).toMatchObject({ n: 3, answer: "no", overflow: true });
    expect(r.decisions.map((d) => d.summary)).toEqual(["a", "b", "c"]);
  });

  it("функция получает summary/kind/номер; мусор и исключение → «no» + overflow", () => {
    const seen: unknown[] = [];
    const r = createConfirmRunner((s, k, n) => (seen.push([s, k, n]), (n === 1 ? "yes" : (n === 2 ? "bogus" : (() => { throw new Error("x"); })())) as never));
    expect(r.decide("s1", "send").answer).toBe("yes");
    expect(r.decide("s2", "send")).toMatchObject({ answer: "no", overflow: true });
    expect(r.decide("s3", "send")).toMatchObject({ answer: "no", overflow: true });
    expect(seen[0]).toEqual(["s1", "send", 1]);
  });

  it("явное «no» из политики — не overflow", () => {
    expect(createConfirmRunner("no").decide("a", "send").overflow).toBeUndefined();
  });

  it("ответы протокола: expire/undelivered несут outcome сразу, yes/no — нет", () => {
    expect(toConfirmResult("r", "yes")).toEqual({ requestId: "r", approved: true });
    expect(toConfirmResult("r", "no")).toEqual({ requestId: "r", approved: false });
    expect(toConfirmResult("r", "expire")).toEqual({ requestId: "r", approved: false, outcome: "expired" });
    expect(toConfirmResult("r", "undelivered")).toEqual({ requestId: "r", approved: false, outcome: "undelivered" });
  });

  it("answerOf обратен toConfirmResult", () => {
    for (const a of ["yes", "no", "expire", "undelivered"] as const) expect(answerOf(toConfirmResult("r", a))).toBe(a);
  });

  it("CLI-разбор: одно значение, список, мусор — ошибка", () => {
    expect(parseConfirmPolicy("yes")).toBe("yes");
    expect(parseConfirmPolicy("yes, no ,expire")).toEqual(["yes", "no", "expire"]);
    expect(() => parseConfirmPolicy("maybe")).toThrow(/допустимо/u);
  });
});
