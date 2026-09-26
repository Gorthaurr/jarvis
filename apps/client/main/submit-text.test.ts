import { describe, expect, it, vi } from "vitest";
import { submitTypedText, type SubmitTextDeps } from "./submit-text.js";

function deps(online: boolean) {
  const d = {
    send: vi.fn((_t: string) => online),
    setState: vi.fn(),
    notify: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
  } satisfies SubmitTextDeps;
  return d;
}

describe("submitTypedText — чат идёт в мозг целиком (боевой прогон 26.09)", () => {
  it("команда с инструкцией уходит на сервер дословно, а не в локальный запуск «блокнот и напиши…»", () => {
    const d = deps(true);
    submitTypedText("  открой блокнот и напиши в нём: привет от Джарвиса ", d);
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send).toHaveBeenCalledWith("открой блокнот и напиши в нём: привет от Джарвиса");
    expect(d.notify).not.toHaveBeenCalled();
    expect(d.setState).toHaveBeenLastCalledWith("thinking");
  });

  it("простые команды («открой блокнот», «громче») тоже решает сервер — второго tier0 на клиенте нет", () => {
    for (const phrase of ["открой блокнот", "громче", "запусти дискорд"]) {
      const d = deps(true);
      submitTypedText(phrase, d);
      expect(d.send).toHaveBeenCalledWith(phrase);
    }
  });

  it("нет связи — честно: карточка «не отправлена», орб не висит в thinking", () => {
    const d = deps(false);
    submitTypedText("открой блокнот", d);
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(d.notify.mock.calls[0]?.[1]).toMatch(/не отправлена/u);
    expect(d.setState).toHaveBeenLastCalledWith("idle");
  });

  it("пустой ввод — ничего не шлём и состояние не трогаем", () => {
    const d = deps(true);
    submitTypedText("   ", d);
    expect(d.send).not.toHaveBeenCalled();
    expect(d.setState).not.toHaveBeenCalled();
  });
});
