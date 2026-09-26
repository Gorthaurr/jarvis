/**
 * Ревью 2026-09-24 (H-C1): навык, который учит ХОЛОДНОМУ инструменту (input_click / ui_snapshot / app_focus …), стоит
 * лишнего раунда tool_load на каждом выполнении — а с W4 у каждого такого есть горячий путь (act / look / window).
 * Общая библиотека видна ВСЕМ пользователям, поэтому страж стоит здесь: новая процедура с холодным инструментом —
 * падение сборки, а не тихий регресс рук. Исключение — явно разрешённые (с объяснением).
 * Реверт: верни в dota2-menu «ui_snapshot пуст → screen_read_text» — тест упадёт.
 */
import { COLD_TOOL_NAMES } from "@jarvis/tools";
import { describe, expect, it } from "vitest";
import { parseSkillMd } from "../memory/skills.js";
import { SHARED_SKILL_SEED } from "./shared-skills.js";

/**
 * Холодные инструменты, которые процедуре разрешено называть: у них нет горячего двойника.
 * W1: browser_batch отсюда убран — он ГОРЯЧИЙ (берст на экран формы — главный рычаг рук во вкладке); вернись он в
 * COLD, навыки, которые на нём стоят (generic-site-actions, lms-quiz), страж обязан поймать.
 */
const ALLOWED_COLD = new Set<string>(["knowledge_consult", "message_send", "skill_promote", "telegram_send_voice"]);

describe("общая библиотека навыков", () => {
  it("процедуры не учат холодным инструментам, у которых есть горячий путь (act/look/window/audio)", () => {
    const offenders: string[] = [];
    for (const md of SHARED_SKILL_SEED) {
      const id = String(parseSkillMd(md).frontmatter.id);
      for (const name of COLD_TOOL_NAMES) {
        if (ALLOWED_COLD.has(name)) continue;
        if (new RegExp(`(^|[^\\w])${name}([^\\w]|$)`, "u").test(md)) offenders.push(`${id}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // W1 (B-11): generic-site-actions учил «логин: почта+пароль+кнопка одним берстом» — пароль вводит ВЛАДЕЛЕЦ (§0).
  // Реверт: верни ту строку — тест упадёт.
  it("процедура не учит вводить пароль: каждое упоминание пароля — рядом с «владелец» (вводит он сам, §0)", () => {
    const offenders: string[] = [];
    for (const md of SHARED_SKILL_SEED) {
      const id = String(parseSkillMd(md).frontmatter.id);
      const lines = md.split("\n");
      lines.forEach((line, i) => {
        if (!/парол/iu.test(line)) return;
        const near = [lines[i - 1], line, lines[i + 1]].join(" ");
        if (!/владел/iu.test(near)) offenders.push(`${id}: ${line.trim().slice(0, 80)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("проза процедуры не парсится в шаги реплея (иначе навык стал бы слепым макросом)", () => {
    for (const md of SHARED_SKILL_SEED) expect(parseSkillMd(md).steps, String(parseSkillMd(md).frontmatter.id)).toEqual([]);
  });
});
