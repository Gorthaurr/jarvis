/**
 * W2 (П4, G-17): прокрутка из демонстрации не пишется UIA-паттерном scroll (ScrollPattern сайдкара крутит только вниз
 * мелким шагом — реплей прокрутил бы не туда) и не пропадает молча: черновик называет её в описании и в `skipped`.
 * Реверт-проверка: верни `case "scroll": return "scroll"` в patternFor — падает первый кейс.
 */
import { describe, expect, it } from "vitest";
import type { DemoEvent } from "@jarvis/protocol";
import { parseSkillMd } from "../../memory/skills.js";
import { buildSkillDraft, demoEventsToSteps } from "./demo.js";

const EVENTS: DemoEvent[] = [
  { role: "list", name: "Файлы", action: "scroll", ts: 1 },
  { role: "listitem", name: "отчёт.docx", action: "select", ts: 2 },
];

describe("демонстрация: прокрутка — честный пропуск (G-17)", () => {
  it("scroll не превращается в ui.invoke{pattern:scroll}", () => {
    const steps = demoEventsToSteps(EVENTS);
    expect(steps.some((s) => s.params?.pattern === "scroll")).toBe(false);
    expect(steps).toEqual([expect.objectContaining({ action: "ui.invoke", params: { pattern: "select" } })]);
  });

  it("черновик называет пропущенную прокрутку (skipped + описание SKILL.md), остальное — как было", () => {
    const d = buildSkillDraft({ id: "open_report", name: "Открыть отчёт", events: EVENTS, commentary: "открываю отчёт" });
    expect(d.skipped).toEqual(["прокрутка «Файлы»"]);
    const parsed = parseSkillMd(d.contentMd);
    expect(parsed.frontmatter.description).toMatch(/открываю отчёт.*не записано: прокрутка «Файлы»/u);
    expect(parsed.steps).toEqual(d.steps);
  });

  it("без прокрутки — пустой skipped и описание без пометок", () => {
    const d = buildSkillDraft({ id: "x", name: "X", events: [EVENTS[1]!] });
    expect(d.skipped).toEqual([]);
    expect(parseSkillMd(d.contentMd).frontmatter.description).toBeUndefined();
  });
});
