/**
 * W2 (пакет 0): одна сборка опций журнала на четыре места. Журнал чекпойнта обязан получать КАЖДЫЙ сигнал честности
 * петли; тест кормит настоящий buildResumeDigest опциями из digestOptions и проверяет, что отказ §14, неизвестный исход
 * и частичное исполнение дошли до текста (реверт: убрать поле из digestOptions — строка журнала пропадёт).
 */
import { describe, expect, it } from "vitest";
import type { LlmMessage } from "../../../integrations/llm.js";
import { buildResumeDigest } from "../checkpoint.js";
import { digestOptions } from "./digest-options.js";
import { createLoopState } from "./state.js";

const call = (id: string, name: string, input: Record<string, unknown>): LlmMessage[] => [
  { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: false }] },
] as unknown as LlmMessage[];

describe("digestOptions", () => {
  it("все множества честности петли — те же объекты (новый сигнал не теряется в одной из копий)", () => {
    const st = createLoopState({ tier: "sonnet", model: "m" });
    const o = digestOptions(st, () => "mutate");
    expect(o.confirmedSends).toBe(st.honesty.confirmedSends);
    expect(o.declinedCalls).toBe(st.honesty.declinedCalls);
    expect(o.uncertainCalls).toBe(st.honesty.uncertainCalls);
    expect(o.partialCalls).toBe(st.honesty.partialCalls);
    expect(o.skippedCalls).toBe(st.honesty.skippedCalls);
    expect(o.systemNotes).toBe(st.progress.systemNotes);
  });

  it("журнал видит отказ §14 и неизвестный исход из состояния петли", () => {
    const st = createLoopState({ tier: "sonnet", model: "m" });
    st.honesty.declinedCalls.add("t1");
    st.honesty.uncertainCalls.add("t2");
    const convo: LlmMessage[] = [
      { role: "user", content: "отправь Кате привет" } as LlmMessage,
      ...call("t1", "input_key", { combo: "Enter" }),
      ...call("t2", "act", { target: "Отправить" }),
    ];
    const plain = buildResumeDigest(convo, { effectOf: () => "mutate" });
    const withState = buildResumeDigest(convo, digestOptions(st, () => "mutate"));
    expect(withState).not.toBe(plain);
    expect(withState).toMatch(/input_key\([^)]*\) — НЕ ВЫПОЛНЕНО/u);
    expect(withState).toMatch(/act\([^)]*\) — ИСХОД НЕИЗВЕСТЕН/u);
  });
});
