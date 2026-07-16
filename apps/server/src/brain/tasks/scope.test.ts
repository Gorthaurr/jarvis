import { describe, expect, it } from "vitest";
import { classifyTaskScope, isDuplicateGoal, looksLikeStatusQuery } from "./scope.js";

describe("classifyTaskScope — правка текущей vs новая задача (§20)", () => {
  it("явные маркеры правки → edit", () => {
    expect(classifyTaskScope("добавь раздел про флот")).toBe("edit");
    expect(classifyTaskScope("сделай подробнее")).toBe("edit");
    expect(classifyTaskScope("исправь дату во введении")).toBe("edit");
    expect(classifyTaskScope("допиши заключение")).toBe("edit");
    expect(classifyTaskScope("сократи это")).toBe("edit"); // «сократи» как стем
  });

  it("ссылки на текущий объект → edit", () => {
    expect(classifyTaskScope("добавь туда таблицу")).toBe("edit");
    expect(classifyTaskScope("в этот документ ещё график")).toBe("edit");
  });

  it("самостоятельное новое дело → new", () => {
    expect(classifyTaskScope("а ещё закажи такси")).toBe("new");
    expect(classifyTaskScope("открой почту")).toBe("new");
    expect(classifyTaskScope("посчитай смету на ремонт")).toBe("new");
    expect(classifyTaskScope("найди рейсы в Сочи")).toBe("new");
  });

  it("по умолчанию (без маркеров правки) → new — чтобы отдельная задача запускалась", () => {
    expect(classifyTaskScope("сделай презентацию по проекту")).toBe("new");
    expect(classifyTaskScope("")).toBe("new");
  });

  it("маркеры ОТКАЗА/редиректа («не то / не так / вместо») → edit (рулёжка текущей задачи)", () => {
    expect(classifyTaskScope("нет, не то")).toBe("edit");
    expect(classifyTaskScope("нет блин не то")).toBe("edit");
    expect(classifyTaskScope("ты делаешь не так")).toBe("edit");
    expect(classifyTaskScope("вместо этого открой сайт")).toBe("edit");
    expect(classifyTaskScope("сделай по другому")).toBe("edit");
    // бареное «лучше/иначе» НЕ должно ложно ловиться как правка (частотны вне рулёжки)
    expect(classifyTaskScope("лучше закажи такси")).toBe("new");
  });

  it("A2 (форензика 2026-07-14): ПРЕТЕНЗИЯ «не сработало/не сделано» при активной задаче → edit (доведи, не новая)", () => {
    // Живой эпизод: «это не сделал», «нихуя не перемотал», «не ушло» уходили scope=new → вторая пустая
    // петля вместо доведения. Теперь — правка текущей задачи (re-verify/добей).
    expect(classifyTaskScope("это не сделал")).toBe("edit");
    expect(classifyTaskScope("вот видишь у меня дошло до 35 и ты нихуя не перемотал")).toBe("edit");
    expect(classifyTaskScope("Джарвис не ушло")).toBe("edit");
    expect(classifyTaskScope("сообщение не отправлено")).toBe("edit");
    expect(classifyTaskScope("так и не получилось")).toBe("edit");
    // но самостоятельное «не» без претензии к выполненному — не ложный edit
    expect(classifyTaskScope("не забудь про встречу завтра")).toBe("new");
  });

  it("A2 (ревью р2 #4): общие «ничего не / так и не» УБРАНЫ — новая команда не проглатывается как правка", () => {
    expect(classifyTaskScope("на завтра ничего не запланировано, покажи календарь")).toBe("new");
    expect(classifyTaskScope("так и не решил, закажи такси")).toBe("new");
    expect(classifyTaskScope("до сих пор не пойму, открой настройки")).toBe("new");
  });
});

describe("looksLikeStatusQuery — претензия/статус-запрос vs инструкция-правка (fix 2026-07-15)", () => {
  it("претензия о невыполнении → статус-запрос (не «поправляю»)", () => {
    expect(looksLikeStatusQuery("ты не сделал это")).toBe(true);
    expect(looksLikeStatusQuery("я не вижу, чтобы ты что-то делал")).toBe(true);
    expect(looksLikeStatusQuery("нихуя не перемотал")).toBe(true);
    expect(looksLikeStatusQuery("сообщение не отправлено")).toBe(true);
  });

  it("прямой вопрос о ходе → статус-запрос", () => {
    expect(looksLikeStatusQuery("ну что там")).toBe(true);
    expect(looksLikeStatusQuery("готово?")).toBe(true);
    expect(looksLikeStatusQuery("ты сделал?")).toBe(true);
    expect(looksLikeStatusQuery("ещё долго?")).toBe(true);
    expect(looksLikeStatusQuery("что ты сейчас делаешь")).toBe(true);
  });

  it("инструкция-правка («добавь/переделай/вместо») — НЕ статус-запрос (останется «поправляю»)", () => {
    expect(looksLikeStatusQuery("добавь раздел про флот")).toBe(false);
    expect(looksLikeStatusQuery("переделай вступление")).toBe(false);
    expect(looksLikeStatusQuery("вместо этого открой сайт")).toBe(false);
    expect(looksLikeStatusQuery("сделай подробнее")).toBe(false);
    expect(looksLikeStatusQuery("")).toBe(false);
  });
});

describe("isDuplicateGoal — дубль-гейт активной задачи (§20, аудит 2026-07-02)", () => {
  it("живой случай: «продолжи/продолжу видео на ютубе» — дубль (STT-вариация словоформы)", () => {
    expect(isDuplicateGoal("продолжу видео на ютубе.", "продолжи видео на ютубе.")).toBe(true);
    expect(isDuplicateGoal("запусти поиск в доте", "запусти поиск в доте.")).toBe(true); // дословный повтор
  });

  it("разные дела при общих словах — НЕ дубль", () => {
    expect(isDuplicateGoal("прими матч в доте", "запусти поиск в доте")).toBe(false);
    expect(isDuplicateGoal("открой почту", "открой ютуб")).toBe(false);
    expect(isDuplicateGoal("закажи такси", "напиши реферат про такси")).toBe(false);
  });

  it("однословные фразы — не рискуем (не дубль)", () => {
    expect(isDuplicateGoal("ютуб", "открой ютуб")).toBe(false);
    expect(isDuplicateGoal("", "открой ютуб")).toBe(false);
  });

  // Живой эпизод 2026-07-10: повтор «запусти поиск в доте» распознан ОБРЫВКОМ ЛАТИНИЦЕЙ «в dot'е.» →
  // Жаккар 0.17 → вторая параллельная задача, обе убиты потолком 240с, $1.09 впустую.
  it("фрагмент-повтор цели (подмножество) — дубль", () => {
    expect(isDuplicateGoal("в доте", "запусти поиск в доте.")).toBe(true);
    expect(isDuplicateGoal("запусти поиск", "запусти поиск в доте.")).toBe(true);
  });

  it("STT-обрывок латиницей/миксом (живой случай «в dot'е.») — дубль", () => {
    expect(isDuplicateGoal("в dot'е.", "запусти поиск в доте.")).toBe(true);
  });

  it("фрагмент с ДРУГИМ действием при общих словах — НЕ дубль", () => {
    expect(isDuplicateGoal("прими матч в доте", "запусти поиск в доте.")).toBe(false);
    expect(isDuplicateGoal("найди билеты в москву", "найди отель в москве")).toBe(false);
  });

  // Адверсариал-ревью 2026-07-10: префикс/стем-вложение в короткой стороне давало массовые ложные
  // «Уже делаю» на бытовых парах → фрагмент-ветка переведена на ТОЧНЫЕ ПОЛНЫЕ токены.
  it("похожие корни ≠ дубль (ревью: свет/светлая, курс/курсовая, почту/почти…)", () => {
    expect(isDuplicateGoal("найди новости", "найди новостройки в москве")).toBe(false);
    expect(isDuplicateGoal("включи свет", "включи светлую тему в редакторе")).toBe(false);
    expect(isDuplicateGoal("проверь курс", "проверь курсовую работу на ошибки")).toBe(false);
    expect(isDuplicateGoal("проверь почту", "проверь отчет он почти готов")).toBe(false);
    expect(isDuplicateGoal("проверь комп", "проверь компиляцию проекта")).toBe(false);
    expect(isDuplicateGoal("запусти таймер", "запусти таймлапс рендера в блендере")).toBe(false);
    expect(isDuplicateGoal("открой ютуб", "найди на ютубе видео про готовку и открой")).toBe(false);
  });

  it("stop-обёртка вокруг цели — НЕ дубль лексически (полярность решает агент-слой)", () => {
    // «останови запуск поиска в доте» лексически близко, но полные токены (запуск≠запусти,
    // поиска≠поиск) не дают overlap ≥0.8 — плюс в агенте стоит полярность-гард.
    expect(isDuplicateGoal("останови запуск поиска в доте", "запусти поиск в доте")).toBe(false);
  });
});
