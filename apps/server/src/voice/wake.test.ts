import { describe, it, expect } from "vitest";
import { isWakeAddressed, stripWake } from "./wake.js";

describe("wake word «Джарвис»", () => {
  it("распознаёт обращение в разных формах и позициях", () => {
    expect(isWakeAddressed("Джарвис, который час")).toBe(true);
    expect(isWakeAddressed("открой блокнот, джарвис")).toBe(true);
    expect(isWakeAddressed("окей джарвес ты тут")).toBe(true);
    expect(isWakeAddressed("jarvis open notepad")).toBe(true);
  });

  it("НЕ срабатывает без обращения", () => {
    expect(isWakeAddressed("который сейчас час")).toBe(false);
    expect(isWakeAddressed("привет, как дела")).toBe(false);
  });

  it("не цепляет слово внутри другого", () => {
    expect(isWakeAddressed("джарвисовский протокол")).toBe(false);
  });

  it("вырезает обращение с прилегающей пунктуацией, оставляя команду", () => {
    expect(stripWake("Джарвис, открой блокнот")).toBe("открой блокнот");
    expect(stripWake("открой блокнот, джарвис")).toBe("открой блокнот");
    expect(stripWake("Джарвис")).toBe("");
  });
});
