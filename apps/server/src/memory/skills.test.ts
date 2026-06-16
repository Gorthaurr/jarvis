import { describe, expect, it } from "vitest";
import {
  type RecalledSkill,
  createSkillProvider,
  isGuardStep,
  isLearnedMd,
  matchLearnedSkill,
  parseSkillMd,
  serializeLearnedSkill,
  serializeSkill,
  slugify,
} from "./skills.js";

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

describe("выученные навыки-процедуры (§8 HERMES)", () => {
  it("serializeLearnedSkill: source=learned, description=when, тело-процедура парсятся обратно", () => {
    const md = serializeLearnedSkill({
      id: "tg",
      name: "Отчёт в Telegram",
      version: 2,
      when: "прислать отчёт в телеграм",
      procedure: "1. собрать данные\n2. отправить через telegram_send\nГрабли: проверить имя чата",
    });
    const { frontmatter } = parseSkillMd(md);
    expect(frontmatter.source).toBe("learned");
    expect(frontmatter.name).toBe("Отчёт в Telegram");
    expect(frontmatter.description).toBe("прислать отчёт в телеграм");
    expect(frontmatter.version).toBe(2);
    expect(md).toContain("отправить через telegram_send"); // процедура — это тело, не frontmatter
  });

  it("serializeLearnedSkill схлопывает многострочный when в одну строку frontmatter", () => {
    const md = serializeLearnedSkill({ id: "x", name: "X", version: 1, when: "когда\nпросят\nотчёт", procedure: "шаг" });
    expect(parseSkillMd(md).frontmatter.description).toBe("когда просят отчёт");
  });

  const LEARNED: RecalledSkill[] = [
    { id: "tg", name: "Отчёт в Telegram", when: "прислать отчёт в телеграм", procedure: "...", version: 1 },
    { id: "excel", name: "Свести таблицу", when: "посчитать сумму в экселе", procedure: "...", version: 1 },
  ];

  it("matchLearnedSkill: подбирает навык по лексическому перекрытию (терпит морфологию)", () => {
    expect(matchLearnedSkill("пришли отчёт в телеграм", LEARNED)?.id).toBe("tg");
    expect(matchLearnedSkill("посчитай сумму в экселе", LEARNED)?.id).toBe("excel");
  });

  it("matchLearnedSkill: нет перекрытия → null (ложный recall вреднее пропуска)", () => {
    expect(matchLearnedSkill("какая погода завтра", LEARNED)).toBeNull();
    expect(matchLearnedSkill("", LEARNED)).toBeNull();
    expect(matchLearnedSkill("отчёт", LEARNED)).toBeNull(); // одно слово — ниже порога (≥2 попаданий)
  });

  it("matchLearnedSkill: чужие слова с коротким общим префиксом НЕ матчатся (стемминг длинозависимый)", () => {
    const collide: RecalledSkill[] = [
      { id: "stol", name: "Столица", when: "столовые приборы", procedure: "...", version: 1 },
      { id: "post", name: "Почта", when: "почтовая марка", procedure: "...", version: 1 },
    ];
    // «стол*»/«поч*» — общий префикс 4 симв., но слова разные → не должно сработать.
    expect(matchLearnedSkill("столкнулся с проблемой", collide)).toBeNull();
    expect(matchLearnedSkill("почти получилось вчера", collide)).toBeNull();
  });

  it("matchLearnedSkill: порог 0.34 — 2 попадания из 6 целей (0.333) ниже порога", () => {
    const six: RecalledSkill[] = [
      { id: "six", name: "Открыть Notion базу заметок проекта плана", when: "", procedure: "...", version: 1 },
    ];
    // 6 значимых query-токенов, 2 точных попадания → 2/6=0.333 < 0.34 → null.
    expect(matchLearnedSkill("открыть заметок погоду футбол кино музыку", six)).toBeNull();
    // добавили третье попадание (базу) → 3/6=0.5 ≥ 0.34 → матч.
    expect(matchLearnedSkill("открыть заметок базу погоду футбол музыку", six)?.id).toBe("six");
  });

  it("matchLearnedSkill: тай-брейк по id детерминирован при равном счёте", () => {
    const tie: RecalledSkill[] = [
      { id: "bbb", name: "Отчёт телеграм", when: "", procedure: "...", version: 1 },
      { id: "aaa", name: "Отчёт телеграм", when: "", procedure: "...", version: 1 },
    ];
    expect(matchLearnedSkill("отчёт телеграм", tie)?.id).toBe("aaa"); // меньший id, независимо от порядка
    expect(matchLearnedSkill("отчёт телеграм", [...tie].reverse())?.id).toBe("aaa");
  });

  it("slugify: кириллица → латинский кебаб-слаг (детерминированный id)", () => {
    expect(slugify("Отчёт в Telegram")).toBe("otchet-v-telegram");
    expect(slugify("  ")).toBe("skill");
  });

  it("isLearnedMd различает выученную процедуру и записанный показом навык", () => {
    const learned = serializeLearnedSkill({ id: "x", name: "X", version: 1, when: "y", procedure: "z" });
    expect(isLearnedMd(learned)).toBe(true);
    expect(isLearnedMd("---\nid: open\nname: Открыть\n---\n## Шаги\n1. app.launch app=\"X\"")).toBe(false);
  });

  it("createSkillProvider: save→recall работает БЕЗ БД (in-memory фолбэк), version растёт, learned изолированы", async () => {
    const sp = createSkillProvider();
    const u = "u-hermes-nodb";
    const saved = await sp.save(u, {
      name: "Отчёт в Telegram",
      when: "прислать отчёт в телеграм",
      procedure: "1. собрать данные\n2. отправить через telegram_send",
    });
    expect(saved?.version).toBe(1);
    expect(saved?.id.startsWith("learned__")).toBe(true); // id выученного навыка изолирован

    const r = await sp.recall(u, "пришли отчёт в телеграм");
    expect(r?.name).toBe("Отчёт в Telegram");
    expect(r?.procedure).toContain("отправить через telegram_send");

    // повторное сохранение того же имени → версия растёт (улучшение §8).
    const again = await sp.save(u, { name: "Отчёт в Telegram", when: "прислать отчёт", procedure: "обновлённая процедура" });
    expect(again?.version).toBe(2);

    // выученные-процедуры НЕ в реплей-каталоге и НЕ резолвятся для skill_execute.
    expect(await sp.list(u)).toHaveLength(0);
    expect(await sp.get(u, again!.id)).toBeNull();
  });
});
