import { describe, expect, it } from "vitest";
import { isGuardStep, parseSkillMd, serializeSkill } from "./skills.js";

const SAMPLE = `---
id: send_vk
name: Написать в VK
version: 3
---

## Шаги
1. app.focus app="VK Messenger"
2. ui.invoke role="list" name="Чаты" pattern="invoke" expectRole="list"
3. input.type text="привет" expectRole="textbox" expectName="Сообщение"
4. message.send
`;

describe("parseSkillMd (§8)", () => {
  it("парсит фронтматтер и шаги", () => {
    const { frontmatter, steps } = parseSkillMd(SAMPLE);
    expect(frontmatter.id).toBe("send_vk");
    expect(frontmatter.version).toBe(3);
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatchObject({ action: "app.focus", params: { app: "VK Messenger" } });
    expect(steps[1]).toMatchObject({
      action: "ui.invoke",
      target: { by: "role", role: "list", name: "Чаты" },
      expect: { role: "list" },
    });
    expect(steps[2]?.expect).toEqual({ role: "textbox", name: "Сообщение" });
  });

  it("не дублирует expect/служебные ключи в params", () => {
    const { steps } = parseSkillMd(SAMPLE);
    expect(steps[2]?.params).toEqual({ text: "привет" }); // без expectRole/expectName
  });

  it("round-trip: parse → serialize → parse сохраняет шаги", () => {
    const first = parseSkillMd(SAMPLE);
    const md2 = serializeSkill({ id: "send_vk", name: "Написать в VK", version: 3 }, first.steps);
    const second = parseSkillMd(md2);
    expect(second.steps).toEqual(first.steps);
  });
});

describe("isGuardStep (§8, §14)", () => {
  it("guard: message.send / order.place / code.run / confirm", () => {
    expect(isGuardStep({ action: "message.send" })).toBe(true);
    expect(isGuardStep({ action: "order.place" })).toBe(true);
    expect(isGuardStep({ action: "code.run" })).toBe(true);
    expect(isGuardStep({ action: "confirm" })).toBe(true);
  });
  it("powershell code.run — guard", () => {
    expect(isGuardStep({ action: "code.run", params: { lang: "powershell" } })).toBe(true);
  });
  it("обычные шаги — не guard", () => {
    expect(isGuardStep({ action: "ui.invoke" })).toBe(false);
    expect(isGuardStep({ action: "input.type" })).toBe(false);
  });
});
