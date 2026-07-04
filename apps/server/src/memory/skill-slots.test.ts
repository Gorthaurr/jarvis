import type { SkillStep } from "@jarvis/protocol";
import { describe, expect, it } from "vitest";
import { extractSlots, fillSlots } from "./skill-slots.js";

describe("skill-slots: extractSlots", () => {
  it("собирает слоты из params, target и expect, дедуплицирует", () => {
    const steps: SkillStep[] = [
      { action: "app.launch", params: { app: "{{program}}" } },
      {
        action: "ui.invoke",
        target: { by: "role", role: "button", name: "{{btn}}" },
        params: { value: "{{text}}" },
        expect: { role: "edit", name: "{{btn}}", text: "{{done}}" },
      },
    ];
    expect(extractSlots(steps).sort()).toEqual(["btn", "done", "program", "text"]);
  });

  it("литеральный навык без слотов → пустой список", () => {
    const steps: SkillStep[] = [
      { action: "app.launch", params: { app: "Notion" } },
      { action: "input.type", params: { text: "Заметка" } },
    ];
    expect(extractSlots(steps)).toEqual([]);
  });

  it("видит слоты в target.handle и игнорирует числовые координаты", () => {
    const steps: SkillStep[] = [
      { action: "ui.invoke", target: { by: "handle", handle: "{{h}}" } },
      { action: "input.click", target: { by: "coords", x: 10, y: 20 } },
    ];
    expect(extractSlots(steps)).toEqual(["h"]);
  });
});

describe("skill-slots: fillSlots", () => {
  it("подставляет переданные переменные в params/target/expect", () => {
    const steps: SkillStep[] = [
      { action: "app.launch", params: { app: "{{program}}" } },
      {
        action: "ui.invoke",
        target: { by: "role", role: "button", name: "{{btn}}" },
        expect: { role: "button", name: "{{btn}}" },
      },
    ];
    const { steps: out, missing } = fillSlots(steps, { program: "Telegram", btn: "Отправить" });
    expect(missing).toEqual([]);
    expect(out[0]!.params).toEqual({ app: "Telegram" });
    expect(out[1]!.target).toEqual({ by: "role", role: "button", name: "Отправить" });
    expect(out[1]!.expect).toEqual({ role: "button", name: "Отправить" });
  });

  it("несколько слотов в одной строке + повтор имени", () => {
    const steps: SkillStep[] = [{ action: "message.send", params: { body: "Привет, {{name}}! {{name}}, ты тут?" } }];
    const { steps: out, missing } = fillSlots(steps, { name: "Герман" });
    expect(missing).toEqual([]);
    expect(out[0]!.params!.body).toBe("Привет, Герман! Герман, ты тут?");
  });

  it("незаполненный слот → в missing, плейсхолдер остаётся (честность)", () => {
    const steps: SkillStep[] = [{ action: "message.send", params: { to: "{{contact}}", body: "{{text}}" } }];
    const { steps: out, missing } = fillSlots(steps, { contact: "Герман" });
    expect(missing).toEqual(["text"]);
    expect(out[0]!.params).toEqual({ to: "Герман", body: "{{text}}" });
  });

  it("пустая/null переменная считается незаполненной", () => {
    const steps: SkillStep[] = [{ action: "input.type", params: { text: "{{a}}", x: "{{b}}" } }];
    const { missing } = fillSlots(steps, { a: "   ", b: null });
    expect(missing.sort()).toEqual(["a", "b"]);
  });

  it("не-строковые params сохраняются как есть, координаты не трогаются", () => {
    const steps: SkillStep[] = [
      { action: "input.click", target: { by: "coords", x: 5, y: 7 }, params: { count: 3, flag: true } },
    ];
    const { steps: out, missing } = fillSlots(steps, {});
    expect(missing).toEqual([]);
    expect(out[0]!.params).toEqual({ count: 3, flag: true });
    expect(out[0]!.target).toEqual({ by: "coords", x: 5, y: 7 });
  });

  it("исходные шаги не мутируются", () => {
    const steps: SkillStep[] = [{ action: "app.launch", params: { app: "{{program}}" } }];
    const snapshot = JSON.stringify(steps);
    fillSlots(steps, { program: "Steam" });
    expect(JSON.stringify(steps)).toBe(snapshot);
  });

  it("литеральный навык проходит без изменений", () => {
    const steps: SkillStep[] = [
      { action: "app.launch", params: { app: "Notion" } },
      { action: "input.type", params: { text: "Заметка" } },
    ];
    const { steps: out, missing } = fillSlots(steps, { unused: "x" });
    expect(missing).toEqual([]);
    expect(out).toEqual(steps);
  });
});
