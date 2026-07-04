/** §8 МАКРОС: тесты компиляции жестов в реплей-строки + вписывания секции (skill-macro.ts). */
import { describe, expect, it } from "vitest";
import { REPLAY_SECTION_HEADER, attachReplaySection, compileReplayLines, type GestureEvent } from "./skill-macro.js";
import { parseSkillMd } from "./skills.js";

const click = (x: number, y: number, method?: string): GestureEvent => ({
  name: "input_click",
  input: { x: 100, y: 50, ...(method ? { method } : {}) }, // vision-вход модели (не он идёт в макрос)
  data: { screenX: x, screenY: y }, // разрешённые экранные координаты от клиента
});

describe("compileReplayLines", () => {
  it("фокус+клики+клавиши → машинные строки с абсолютными координатами и паузами", () => {
    const lines = compileReplayLines([
      { name: "app_focus", input: { app: "dota2" } },
      click(1200.6, 900.2, "physical"),
      { name: "screen_capture", input: {} }, // глаза модели — в макрос не входят
      click(2100, 700),
      { name: "input_key", input: { combo: "enter" } },
    ]);
    expect(lines).toEqual([
      'app.focus app="dota2"',
      "wait ms=500",
      'input.click x=1201 y=900 space="screen" method="physical"',
      "wait ms=800",
      'input.click x=2100 y=700 space="screen"',
      "wait ms=800",
      'input.key combo="enter"',
      "wait ms=400",
    ]);
  });

  it("клик без разрешённых координат (handle/role) → макрос НЕ компилируется целиком", () => {
    const lines = compileReplayLines([
      { name: "app_focus", input: { app: "dota2" } },
      { name: "input_click", input: { role: "button", name: "Играть" } }, // data нет
      click(100, 100),
    ]);
    expect(lines).toEqual([]);
  });

  it("без жестов ввода (только фокус/скрины) — пусто", () => {
    expect(
      compileReplayLines([
        { name: "app_focus", input: { app: "dota2" } },
        { name: "screen_capture", input: {} },
      ]),
    ).toEqual([]);
  });

  it("строки парсятся обратно parseSkillMd в исполнимые шаги (round-trip, space=screen)", () => {
    const lines = compileReplayLines([{ name: "app_focus", input: { app: "dota2" } }, click(1500, 800, "physical")]);
    const md = `---\nid: t\nname: t\nversion: 1\nsource: learned\n---\n\n${REPLAY_SECTION_HEADER}\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n`;
    const { steps } = parseSkillMd(md);
    expect(steps.map((s) => s.action)).toEqual(["app.focus", "wait", "input.click", "wait"]);
    const clickStep = steps[2]!;
    expect(clickStep.target).toEqual({ by: "coords", x: 1500, y: 800, space: "screen" });
    expect(clickStep.params?.method).toBe("physical");
    const waitStep = steps[3]!;
    expect(waitStep.params?.ms).toBe("800");
  });

  it("кавычки/амперсанды в тексте экранируются (round-trip без разрыва парсинга)", () => {
    const lines = compileReplayLines([
      click(10, 20),
      { name: "input_type", input: { text: 'привет "мир" & co' } },
    ]);
    const md = `---\nid: t\nname: t\nversion: 1\nsource: learned\n---\n\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n`;
    const { steps } = parseSkillMd(md);
    const typeStep = steps.find((s) => s.action === "input.type")!;
    expect(typeStep.params?.text).toBe('привет "мир" & co');
  });
});

describe("attachReplaySection", () => {
  const lines = ['app.focus app="dota2"', "wait ms=500", 'input.click x=1 y=2 space="screen"'];

  it("добавляет секцию в конец процедуры", () => {
    const out = attachReplaySection("## Цель\nтекст\n\n## Шаги\n1. проза", lines);
    expect(out).toContain(REPLAY_SECTION_HEADER);
    expect(out).toContain('3. input.click x=1 y=2 space="screen"');
    expect(out.indexOf("## Цель")).toBeLessThan(out.indexOf(REPLAY_SECTION_HEADER));
  });

  it("заменяет существующую секцию (не плодит вторую), идемпотентна по версии", () => {
    const v1 = attachReplaySection("## Цель\nтекст", lines);
    const v2 = attachReplaySection(v1, lines);
    expect(v2).toBe(v1); // тот же реплей → текст не меняется (вызывающий не бампает версию)
    const v3 = attachReplaySection(v1, ['app.focus app="dota2"', "wait ms=500", 'input.click x=9 y=9 space="screen"']);
    expect(v3).not.toBe(v1);
    expect(v3.split(REPLAY_SECTION_HEADER)).toHaveLength(2); // заголовок ровно один
    expect(v3).toContain("x=9 y=9");
    expect(v3).not.toContain("x=1 y=2");
  });

  it("секция в середине (после неё другой ## раздел) заменяется без затирания хвоста", () => {
    const proc = `## Цель\nтекст\n\n${REPLAY_SECTION_HEADER}\n1. input.click x=1 y=2 space="screen"\n\n## Грабли\nважное`;
    const out = attachReplaySection(proc, lines);
    expect(out).toContain("## Грабли\nважное");
    expect(out).toContain("x=1 y=2"); // из новых строк (совпадает), но секция одна
    expect(out.split(REPLAY_SECTION_HEADER)).toHaveLength(2); // заголовок ровно один
  });
});
