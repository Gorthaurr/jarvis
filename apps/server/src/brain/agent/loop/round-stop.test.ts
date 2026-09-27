/**
 * W2 (П4, G-8): таблица исходов стопа раунда и сводка §7 без заглушек. Проводка — петлёй (round-stop-loop.test.ts);
 * здесь — края, которые петлёй дорого перебирать. Реверт-проверка: `mutate-loop.cjs round-stop-anyerrored`.
 */
import { describe, expect, it } from "vitest";
import type { LlmResponse } from "../../../integrations/llm.js";
import { newRound } from "./round-result.js";
import { noteRoundStop, stopsRound } from "./round-stop.js";
import { summarizeRound } from "./round-classify.js";

const tu = (id: string) => ({ id, name: "act", input: {} });

describe("stopsRound: какие исходы мутации останавливают раунд", () => {
  it.each([
    ["ошибка", { isError: true }, true],
    ["исход неизвестен (act verified:failed — ok, но uncertain)", { isError: false, uncertain: true }, true],
    ["§14 отклонён (ok + declined)", { isError: false, declined: true }, true],
    ["вуаль", { isError: true, overlayDenied: true }, true],
    ["канал мёртв", { isError: true, channelDown: true }, true],
    ["unchecked/met — не провал", { isError: false }, false],
  ] as const)("%s → %s", (_n, r, stop) => {
    expect(stopsRound(r, "mutate")).toBe(stop);
  });

  it("провал ЧТЕНИЯ или нейтрального вызова раунд не останавливает", () => {
    expect(stopsRound({ isError: true }, "verify")).toBe(false);
    expect(stopsRound({ isError: true }, "neutral")).toBe(false);
  });

  it("стоп ставит ПЕРВАЯ провалившаяся мутация", () => {
    const round = newRound();
    noteRoundStop(round, tu("a"), { isError: false }, "mutate");
    noteRoundStop(round, tu("b"), { isError: true }, "mutate");
    noteRoundStop(round, tu("c"), { isError: true }, "mutate");
    expect(round.stoppedBy).toBe("b");
  });
});

describe("summarizeRound (§7) не считает заглушки стопа", () => {
  it("[отказ §14 (ok), заглушка] — раунд без ошибок модели: anyErrored=false, allErrored=false", () => {
    const round = newRound();
    round.resultBlocks.push({ type: "tool_result", tool_use_id: "d1", content: "не подтверждено", is_error: false });
    round.resultBlocks.push({ type: "tool_result", tool_use_id: "a1", content: "НЕ ИСПОЛНЕН", is_error: true });
    round.skippedIds.add("a1");
    const resp = { text: "", toolUses: [tu("d1"), tu("a1")] } as unknown as LlmResponse;
    expect(summarizeRound(resp, round)).toMatchObject({ anyErrored: false, allErrored: false });
  });

  it("[ошибка, заглушка] — раунд провален (реальная ошибка есть)", () => {
    const round = newRound();
    round.resultBlocks.push({ type: "tool_result", tool_use_id: "t1", content: "not_found", is_error: true });
    round.resultBlocks.push({ type: "tool_result", tool_use_id: "k1", content: "НЕ ИСПОЛНЕН", is_error: true });
    round.skippedIds.add("k1");
    const resp = { text: "", toolUses: [tu("t1"), tu("k1")] } as unknown as LlmResponse;
    expect(summarizeRound(resp, round)).toMatchObject({ anyErrored: true, allErrored: true });
  });
});
