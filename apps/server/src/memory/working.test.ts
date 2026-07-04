import { describe, expect, it, vi } from "vitest";
import { WorkingMemory } from "./working.js";

// §5 персист: память диалога должна сериализоваться/восстанавливаться (переживать рестарт) + звать onChange.
describe("WorkingMemory — персист контекста", () => {
  it("toJSON → restore сохраняет реплики (контекст переживает рестарт)", () => {
    const a = new WorkingMemory();
    a.pushTurn("user", "вруби волну");
    a.pushTurn("assistant", "готово");
    const snapshot = a.toJSON();

    const b = new WorkingMemory();
    b.restore(snapshot);
    const turns = b.recentTurns();
    expect(turns.map((t) => t.text)).toEqual(["вруби волну", "готово"]);
  });

  it("restore уважает кольцо maxTurns (берёт самые свежие)", () => {
    const mem = new WorkingMemory(2); // окно 2
    mem.restore({ turns: [
      { role: "user", text: "1", ts: 1 },
      { role: "assistant", text: "2", ts: 2 },
      { role: "user", text: "3", ts: 3 },
    ] });
    expect(mem.recentTurns().map((t) => t.text)).toEqual(["2", "3"]);
  });

  it("onChange дёргается на pushTurn/pushEntity (триггер автосохранения)", () => {
    const onChange = vi.fn();
    const mem = new WorkingMemory(20, 12, onChange);
    mem.pushTurn("user", "привет");
    mem.pushEntity({ type: "url", label: "music.yandex.ru" });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("restore НЕ дёргает onChange (восстановление — не изменение)", () => {
    const onChange = vi.fn();
    const mem = new WorkingMemory(20, 12, onChange);
    mem.restore({ turns: [{ role: "user", text: "x", ts: 1 }] });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("restore(null/пусто) безопасен", () => {
    const mem = new WorkingMemory();
    mem.pushTurn("user", "есть");
    mem.restore(null);
    mem.restore(undefined);
    mem.restore({});
    expect(mem.recentTurns().length).toBe(1); // ничего не затёрли
  });
});
