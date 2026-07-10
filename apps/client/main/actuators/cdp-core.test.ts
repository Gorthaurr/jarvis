/**
 * Чистые примитивы CDP-плумбинга (§6, §ревью-дедуп). Покрываем общую логику, которую раньше
 * дублировали browser-cdp.ts и jarvis-browser.ts: сборка JSON-RPC, разбор ответа по id (события
 * игнорируются), разворачивание Runtime.evaluate (включая исключение в page-контексте).
 */
import { describe, expect, it } from "vitest";
import { type CdpReply, cdpCommand, parseCdpReply, resolveWebSocketCtor, unwrapEvalResult } from "./cdp-core.js";

describe("cdp-core — чистые примитивы CDP", () => {
  it("cdpCommand формирует JSON-RPC, params опускает когда пуст", () => {
    expect(cdpCommand(7, "Page.navigate", { url: "x" })).toEqual({ id: 7, method: "Page.navigate", params: { url: "x" } });
    expect(cdpCommand(1, "Page.enable")).toEqual({ id: 1, method: "Page.enable" });
  });

  it("parseCdpReply возвращает ответ только для кадра с числовым id", () => {
    expect(parseCdpReply(JSON.stringify({ id: 3, result: { value: 42 } }))).toEqual({
      id: 3,
      result: { value: 42 },
      error: undefined,
    });
    const withErr = parseCdpReply(JSON.stringify({ id: 4, error: { message: "boom" } })) as CdpReply;
    expect(withErr.id).toBe(4);
    expect(withErr.error?.message).toBe("boom");
  });

  it("parseCdpReply игнорирует события (без id) и мусор", () => {
    expect(parseCdpReply(JSON.stringify({ method: "Page.loadEventFired", params: {} }))).toBeNull(); // событие
    expect(parseCdpReply(JSON.stringify({ id: "не число" }))).toBeNull();
    expect(parseCdpReply("{не json")).toBeNull();
    expect(parseCdpReply("")).toBeNull();
  });

  it("unwrapEvalResult достаёт result.value и пробрасывает undefined", () => {
    expect(unwrapEvalResult({ result: { value: "ok" } }, "eval")).toBe("ok");
    expect(unwrapEvalResult({ result: {} }, "eval")).toBeUndefined();
    expect(unwrapEvalResult({}, "eval")).toBeUndefined();
  });

  it("unwrapEvalResult бросает с меткой вызывающего при exceptionDetails", () => {
    expect(() => unwrapEvalResult({ exceptionDetails: { text: "ReferenceError: x" } }, "webK eval")).toThrow(
      /webK eval: ReferenceError: x/,
    );
    expect(() => unwrapEvalResult({ exceptionDetails: {} }, "browser eval")).toThrow(/browser eval: исключение/);
  });

  it("resolveWebSocketCtor возвращает конструктор (глобальный или пакет ws)", () => {
    const Ctor = resolveWebSocketCtor();
    expect(typeof Ctor).toBe("function");
  });
});
