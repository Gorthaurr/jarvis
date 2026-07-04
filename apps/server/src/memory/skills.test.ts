import { describe, expect, it } from "vitest";
import {
  type RecalledSkill,
  type SkillDistiller,
  createSkillProvider,
  distillProcedure,
  findDuplicateSkill,
  formatSkillCatalog,
  isGuardStep,
  isLearnedMd,
  matchLearnedSkill,
  findDuplicateSemantic,
  parseSkillMd,
  recallSemantic,
  saveSkill,
  seedSharedSkills,
  serializeLearnedSkill,
  serializeSkill,
  slugify,
} from "./skills.js";
import type { EmbeddingKind, IEmbeddingProvider } from "../integrations/openai-embeddings.js";

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

  const DOTA: RecalledSkill[] = [
    {
      id: "learned__zapustit-poisk-igry-v-dota-2",
      name: "Запустить поиск игры в Dota 2",
      when: "запустить поиск матча в доте, нажать играть",
      procedure: "...",
      version: 1,
    },
  ];

  it("findDuplicateSkill: вариации имени одного навыка сливаются (дота/доте/лишнее слово)", () => {
    // STT-склонение «дота»→«доте» — тот же навык (общие токены запустить/поиск/игры).
    expect(findDuplicateSkill("Запустить поиск игры в Доте 2", "запустить поиск матча в доте", DOTA)?.id).toBe(
      "learned__zapustit-poisk-igry-v-dota-2",
    );
    // Лишнее слово в имени — тоже тот же навык.
    expect(
      findDuplicateSkill("Запустить поиск игры в Dota 2 кнопка играть", "нажать играть в доте, начать поиск", DOTA)?.id,
    ).toBe("learned__zapustit-poisk-igry-v-dota-2");
  });

  it("findDuplicateSkill: разные навыки НЕ сливаются (контр-пример)", () => {
    expect(findDuplicateSkill("Свести таблицу в Excel", "посчитать сумму в экселе", DOTA)).toBeNull();
    // «принять матч» ≠ «запустить поиск» — общих токенов мало (ниже порога дедупа 0.6).
    expect(findDuplicateSkill("Принять найденный матч в Dota 2", "нажать принять когда нашёлся матч", DOTA)).toBeNull();
  });

  it("matchLearnedSkill: гард полярности — стоп-команда НЕ получает запускной навык (2026-07-03)", () => {
    // Токены «поиск/игры/дота» перекрываются с триггером — без гарда был бы матч, а авто-реплей
    // навыка ЗАПУСТИЛ бы поиск на команду прекратить. Гард режет по полярности start↔stop.
    expect(matchLearnedSkill("останови поиск игры в дота 2", DOTA)).toBeNull();
    expect(matchLearnedSkill("прекрати поиск в доте", DOTA)).toBeNull();
    // Совпадающая полярность матчится как раньше.
    expect(matchLearnedSkill("запусти поиск игры в доте", DOTA)?.id).toBe("learned__zapustit-poisk-igry-v-dota-2");
  });

  it("matchLearnedSkill: нет перекрытия → null (ложный recall вреднее пропуска)", () => {
    expect(matchLearnedSkill("какая погода завтра", LEARNED)).toBeNull();
    expect(matchLearnedSkill("", LEARNED)).toBeNull();
    expect(matchLearnedSkill("отчёт", LEARNED)).toBeNull(); // одно слово — ниже порога (≥2 попаданий)
  });

  it("formatSkillCatalog: компактные строки «• имя — когда», кап, пусто на []", () => {
    const cat = formatSkillCatalog([
      { name: "Отправить Герману", when: "когда нужно написать Herman в телеграм" },
      { name: "Свести таблицу", when: "посчитать сумму в экселе" },
    ]);
    expect(cat).toContain("• Отправить Герману — когда нужно написать Herman");
    expect(cat.split("\n")).toHaveLength(2);
    expect(formatSkillCatalog([])).toBe("");
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `S${i}`, when: "когда-то" }));
    expect(formatSkillCatalog(many, 5).split("\n")).toHaveLength(5);
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

  it("matchLearnedSkill P2.3: навык с failCount ≥ порога (3) НЕ подсовывается (учится на ошибках)", () => {
    const flaky: RecalledSkill[] = [
      { id: "tg", name: "Отчёт в Telegram", when: "прислать отчёт в телеграм", procedure: "...", version: 1, failCount: 3 },
    ];
    expect(matchLearnedSkill("пришли отчёт в телеграм", flaky)).toBeNull(); // 3 провала → подавлен
    expect(matchLearnedSkill("пришли отчёт в телеграм", [{ ...flaky[0]!, failCount: 2 }])?.id).toBe("tg"); // 2 < порога → ещё жив
  });

  it("createSkillProvider.recordOutcome P2.3: провалы копятся → recall глушит навык; успех восстанавливает", async () => {
    const sp = createSkillProvider();
    const u = "u-reliability-p23";
    const saved = await sp.save(u, {
      name: "Открыть вкладку погоды",
      when: "показать прогноз погоды на сайте",
      procedure: "1. открыть сайт погоды\n2. прочитать прогноз",
    });
    expect(await sp.recall(u, "покажи прогноз погоды на сайте")).not.toBeNull(); // сначала подсовывается
    for (let i = 0; i < 3; i += 1) await sp.recordOutcome!(u, saved!.id, false); // три чистых провала
    expect(await sp.recall(u, "покажи прогноз погоды на сайте")).toBeNull(); // подавлен (fail_count=3)
    await sp.recordOutcome!(u, saved!.id, true); // успех гасит провал (3→2)
    expect(await sp.recall(u, "покажи прогноз погоды на сайте")).not.toBeNull(); // снова подсовывается
  });

  it("createSkillProvider.list: параметрический replay-навык показывает слоты (§8)", async () => {
    const sp = createSkillProvider();
    const u = "u-slots-list";
    // Реплей-навык (НЕ learned) с переменными {{...}} в шагах.
    await saveSkill(
      u,
      `---\nid: send-report\nname: Отправить отчёт\nversion: 1\n---\n## Шаги\n1. message.send to="{{contact}}" body="{{text}}"\n`,
    );
    const skill = (await sp.list(u)).find((s) => s.id === "send-report");
    expect(skill?.slots?.slice().sort()).toEqual(["contact", "text"]);

    // Литеральный навык — без поля slots (undefined).
    await saveSkill(u, `---\nid: open-x\nname: Открыть X\nversion: 1\n---\n## Шаги\n1. app.launch app="X"\n`);
    const literal = (await sp.list(u)).find((s) => s.id === "open-x");
    expect(literal?.slots).toBeUndefined();
  });
});

describe("КОРОТКИХ ИМЁН ГРАНИЦА (адверсариал-проверка)", () => {
  it("matchLearnedSkill: 3-символьное имя 'Лев' / 'лев' ОТСЕКАЕТСЯ жадной фильтрацией", () => {
    const skills: RecalledSkill[] = [
      { id: "msg_lev", name: "Написать Льву", when: "когда нужно написать личное сообщение", procedure: "...", version: 1 },
    ];
    // Запрос "сделай что-то лев" -> токены = [сделай] (что=3, лев=3 оба < 4)
    // Навык токены = [написать, льву] (льву=4 символа, на границе)
    // НЕТ перекрытия! лев и льву = разные строки, стемминг не сработает (4+ только точный матч)
    const result = matchLearnedSkill("сделай что-то лев", skills);
    expect(result).toBeNull(); // <- ПОЛОМКА! Навык должен был подобраться, но не подобрался
  });

  it("matchLearnedSkill: 3-символьное имя 'Ада' ОТСЕКАЕТСЯ совсем", () => {
    const skills: RecalledSkill[] = [
      { id: "msg_ada", name: "Написать Аде", when: "когда нужно написать", procedure: "...", version: 1 },
    ];
    // Запрос "напиши аде" -> токены = [напиши] (аде=3 < 4)
    // Навык токены = [написать] (только это есть)
    const result = matchLearnedSkill("напиши аде", skills);
    expect(result).toBeNull(); // <- ПРОБЛЕМА
  });

  it("Граница 4 символа: 'льву' и 'лев' - это разные слова для стемминга (prefix-матч = min 5 символов)", () => {
    // Проверим логику tokenHit: если обе длины < 5, то матч только точный
    // лев (3) vs льву (4) -> need = max(5, ceil(0.75*min(3,4))) = max(5, 2) = 5
    // commonPrefixLen(лев, льву) = 3, но need=5 -> NO MATCH
    const skills: RecalledSkill[] = [
      { id: "msg_lev", name: "Написать Льву", when: "", procedure: "...", version: 1 },
    ];
    // Только если запросим ТОЧНО "льву" - сработает
    expect(matchLearnedSkill("написать льву", skills)?.id).toBe("msg_lev");
    // Но "лев" не сработает
    expect(matchLearnedSkill("написать лев", skills)).toBeNull();
  });
});

describe("recallSemantic (§8 семантический recall навыка)", () => {
  // Фейк-эмбеддер: текст→вектор из карты (контролируем косинус); неизвестный текст → null.
  class FakeEmb implements IEmbeddingProvider {
    readonly dim = 3;
    readonly live = true;
    constructor(private readonly map: Record<string, number[] | null>) {}
    async embed(text: string, _kind?: EmbeddingKind): Promise<number[] | null> {
      return text in this.map ? this.map[text]! : null;
    }
  }
  const SKILLS: RecalledSkill[] = [
    { id: "search-dota", name: "Запустить поиск в Доте", when: "начать матч в доте", procedure: "...", version: 1 },
    { id: "send-tg", name: "Отправить в телеграм", when: "переслать сообщение", procedure: "...", version: 1 },
  ];

  it("перефраз (другие слова) → семантическое попадание, где лексика бы промахнулась", async () => {
    const emb = new FakeEmb({
      "Запустить поиск в Доте. начать матч в доте": [1, 0, 0],
      "Отправить в телеграм. переслать сообщение": [0, 1, 0],
      "найди катку в доту 2": [0.96, 0.28, 0], // cos с dota-триггером ≈0.96 ≥ 0.82
    });
    const r = await recallSemantic(emb, "найди катку в доту 2", SKILLS);
    expect(r?.id).toBe("search-dota");
  });

  it("гард полярности в семантике: «прекрати …» с высоким косинусом к запускному навыку → null (живой случай)", async () => {
    const emb = new FakeEmb({
      "Запустить поиск в Доте. начать матч в доте": [1, 0, 0],
      "Отправить в телеграм. переслать сообщение": [0, 1, 0],
      "прекрати поиск у доти": [0.96, 0.28, 0], // cos ≈0.96 ≥ 0.82 — но полярность противоположна
    });
    // Без гарда вернулся бы search-dota (sim 0.96) и авто-реплей ЗАПУСТИЛ бы поиск на команду
    // остановки. Лексический фолбэк тоже под гардом → чистый null.
    expect(await recallSemantic(emb, "прекрати поиск у доти", SKILLS)).toBeNull();
  });

  it("далёкий запрос ниже порога → лексический фолбэк (тоже мимо) → null", async () => {
    const emb = new FakeEmb({
      "Запустить поиск в Доте. начать матч в доте": [1, 0, 0],
      "Отправить в телеграм. переслать сообщение": [0, 1, 0],
      "какая погода завтра": [0, 0, 1], // cos 0 → ниже порога
    });
    expect(await recallSemantic(emb, "какая погода завтра", SKILLS)).toBeNull();
  });

  it("эмбеддер вернул null → лексический фолбэк ловит точные токены", async () => {
    const emb = new FakeEmb({}); // всё → null
    const r = await recallSemantic(emb, "отправить сообщение в телеграм", SKILLS);
    expect(r?.id).toBe("send-tg"); // matchLearnedSkill по токенам отправить/сообщение/телеграм
  });

  it("findDuplicateSemantic: перефразированный дубль → находит существующий (мёрж, не плодим)", async () => {
    const emb = new FakeEmb({
      "Запустить поиск в Доте. начать матч в доте": [1, 0, 0],
      "Отправить в телеграм. переслать сообщение": [0, 1, 0],
      "Найти игру в Dota. искать катку": [0.97, 0.2, 0], // ≈0.98 с dota-триггером ≥ 0.9
    });
    const dup = await findDuplicateSemantic(emb, "Найти игру в Dota", "искать катку", SKILLS);
    expect(dup?.id).toBe("search-dota");
  });

  it("findDuplicateSemantic: непохожий навык → НЕ дубль (null), новый id", async () => {
    const emb = new FakeEmb({
      "Запустить поиск в Доте. начать матч в доте": [1, 0, 0],
      "Отправить в телеграм. переслать сообщение": [0, 1, 0],
      "Включить музыку. поставить трек": [0.3, 0.3, 0.9], // далеко от обоих
    });
    expect(await findDuplicateSemantic(emb, "Включить музыку", "поставить трек", SKILLS)).toBeNull();
  });
});

describe("§мультитенант: общая библиотека навыков (shared scope, in-memory)", () => {
  it("promote → навык виден ДРУГОМУ юзеру через recall (свои ∪ общие), помечен fromShared", async () => {
    const sp = createSkillProvider();
    const a = "u-shared-a";
    const b = "u-shared-b";
    const saved = await sp.save(a, {
      name: "Полить кактус по расписанию",
      when: "когда нужно полить кактус по расписанию",
      procedure: "1. открыть напоминания\n2. поставить полив",
    });
    expect(saved).not.toBeNull();
    // До promote — юзер B навыка НЕ видит (он приватный у A).
    expect(await sp.recall(b, "полить кактус по расписанию")).toBeNull();
    const pr = await sp.promote!(a, saved!.id);
    expect(pr.ok).toBe(true);
    // После promote — юзер B находит общий навык, помеченный как из общей библиотеки.
    const r = await sp.recall(b, "полить кактус по расписанию");
    expect(r?.name).toBe("Полить кактус по расписанию");
    expect(r?.fromShared).toBe(true);
  });

  it("частный навык ПЕРЕКРЫВАЕТ общий того же id (свой главнее, fromShared=false)", async () => {
    const sp = createSkillProvider();
    const a = "u-ovr-a";
    const b = "u-ovr-b";
    const saved = await sp.save(a, {
      name: "Заварить чай особым способом",
      when: "когда просят заварить чай особым способом",
      procedure: "общая процедура",
    });
    await sp.promote!(a, saved!.id);
    expect((await sp.recall(b, "заварить чай особым способом"))?.fromShared).toBe(true);
    // B сохраняет СВОЙ навык с тем же именем (→ тот же id) → перекрывает общий.
    await sp.save(b, {
      name: "Заварить чай особым способом",
      when: "когда просят заварить чай особым способом",
      procedure: "МОЙ способ заварки",
    });
    const r = await sp.recall(b, "заварить чай особым способом");
    expect(r?.fromShared).toBeFalsy();
    expect(r?.procedure).toContain("МОЙ способ");
  });

  it("promote гардит: не свой навык → not_found; реплей (не процедура) → not_learned", async () => {
    const sp = createSkillProvider();
    const u = "u-promote-guard";
    expect((await sp.promote!(u, "learned__nope")).reason).toBe("not_found");
    // Записанный показом реплей-навык — не процедура → нельзя поднять.
    await saveSkill(u, `---\nid: replay-x\nname: Открыть X\nversion: 1\n---\n## Шаги\n1. app.launch app="X"\n`);
    expect((await sp.promote!(u, "replay-x")).reason).toBe("not_learned");
  });

  it("seedSharedSkills идемпотентен (та же версия не перезаписывает) + засеянное видно любому юзеру", async () => {
    const md = serializeLearnedSkill({
      id: "learned__seed-demo",
      name: "Демо сид навык",
      version: 1,
      when: "когда нужен демо сид навык",
      procedure: "шаг процедуры",
    });
    expect(await seedSharedSkills([md])).toBe(1);
    expect(await seedSharedSkills([md])).toBe(0); // версия не новее → пропуск (идемпотентность)
    const sp = createSkillProvider();
    const r = await sp.recall("u-seed-reader", "когда нужен демо сид навык");
    expect(r?.id).toBe("learned__seed-demo");
    expect(r?.fromShared).toBe(true);
  });
});

describe("§8 мульти-демо дистилляция навыка (идея BrowserBC)", () => {
  it("distillProcedure: 1 показ → свежая; ≥2 + дистиллятор → дистиллят; дистиллятор null/нет → свежая", async () => {
    const distiller: SkillDistiller = async () => "ОБОБЩЁННАЯ ПРОЦЕДУРА";
    const one = [{ when: "w", procedure: "показ1" }];
    const two = [
      { when: "w", procedure: "показ1" },
      { when: "w", procedure: "показ2" },
    ];
    expect(await distillProcedure("n", "w", one, "показ1", distiller)).toBe("показ1"); // 1 показ — не дистиллируем
    expect(await distillProcedure("n", "w", two, "показ2", distiller)).toBe("ОБОБЩЁННАЯ ПРОЦЕДУРА"); // ≥2 → дистиллят
    expect(await distillProcedure("n", "w", two, "показ2", async () => null)).toBe("показ2"); // дистиллятор пуст → свежая
    expect(await distillProcedure("n", "w", two, "показ2", async () => { throw new Error("боом"); })).toBe("показ2"); // упал → свежая
    expect(await distillProcedure("n", "w", two, "показ2")).toBe("показ2"); // нет дистиллятора → свежая
  });

  it("save: 1-й показ — как есть; 2-й показ той же capability → дистилляция в обобщённый навык", async () => {
    const seen: number[] = [];
    const distiller: SkillDistiller = async ({ demonstrations }) => {
      seen.push(demonstrations.length);
      return "ДИСТИЛЛЯТ: обобщённая устойчивая процедура";
    };
    const sp = createSkillProvider(undefined, distiller);
    const u = "u-distill";
    const name = `тест дистилляции ${Date.now()}`; // уникально → нет накопленных показов от прошлых прогонов
    const when = `когда ${name}`;
    const s1 = await sp.save(u, { name, when, procedure: "показ один: шаг А" });
    expect(s1?.version).toBe(1);
    expect(seen.length).toBe(0); // 1 показ — дистиллятор НЕ звался
    const r1 = await sp.recall(u, when);
    expect(r1?.procedure).toBe("показ один: шаг А"); // сохранена свежая

    const s2 = await sp.save(u, { name, when, procedure: "показ два: шаг Б" });
    expect(s2?.id).toBe(s1?.id); // дедуп — та же capability
    expect(s2?.version).toBe(2);
    expect(seen.some((n) => n >= 2)).toBe(true); // дистиллятор получил ≥2 показа
    const r2 = await sp.recall(u, when);
    expect(r2?.procedure).toContain("ДИСТИЛЛЯТ"); // навык стал обобщённым дистиллятом, не «как сделал последний раз»
  });
});
