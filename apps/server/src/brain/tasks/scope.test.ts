import { describe, expect, it } from "vitest";
import { classifyTaskScope, isDuplicateGoal, looksLikeDoneEcho, looksLikeStatusQuery } from "./scope.js";

const REPORT = "напиши отчет про рынок электромобилей"; // активная задача-документ
const DOTA = "запусти поиск матча в доте"; // активная задача-GUI

describe("classifyTaskScope — правка текущей vs новая задача (§20)", () => {
  it("явные маркеры правки ПО ТЕМЕ активной задачи → edit", () => {
    expect(classifyTaskScope("добавь раздел про флот", REPORT)).toBe("edit"); // «раздел» — часть артефакта
    expect(classifyTaskScope("сделай подробнее", REPORT)).toBe("edit"); // своего объекта нет — модификатор
    expect(classifyTaskScope("исправь дату во введении", REPORT)).toBe("edit");
    expect(classifyTaskScope("допиши заключение", REPORT)).toBe("edit");
    expect(classifyTaskScope("сократи это", REPORT)).toBe("edit"); // «сократи» как стем
    expect(classifyTaskScope("поправь отчет", REPORT)).toBe("edit"); // объект = цель задачи
  });

  it("🔴 СМЕНА ТЕМЫ с глаголом правки → new (не ложное «Принял, поправляю»)", () => {
    // Живой дефект 2026-09-01: глагол правки уводил ЛЮБУЮ реплику steer'ом в чужую задачу, и
    // владельцу произносили утверждение о том, чего не произошло.
    expect(classifyTaskScope("добавь напоминание позвонить маме завтра", REPORT)).toBe("new");
    expect(classifyTaskScope("исправь баг в билде", REPORT)).toBe("new");
    expect(classifyTaskScope("измени раскладку клавиатуры", REPORT)).toBe("new");
    expect(classifyTaskScope("добавь молоко в список покупок", DOTA)).toBe("new");
    expect(classifyTaskScope("поправь громкость в наушниках", DOTA)).toBe("new");
    // тот же «раздел», но задача НЕ документная — всё равно правка артефакта не про доту:
    expect(classifyTaskScope("измени раскладку клавиатуры", DOTA)).toBe("new");
  });

  it("ссылки на текущий объект → edit", () => {
    expect(classifyTaskScope("добавь туда таблицу", REPORT)).toBe("edit");
    expect(classifyTaskScope("в этот документ ещё график", REPORT)).toBe("edit");
    expect(classifyTaskScope("добавь туда напоминание", DOTA)).toBe("edit"); // явный дейксис на текущее
  });

  it("самостоятельное новое дело → new", () => {
    expect(classifyTaskScope("а ещё закажи такси", REPORT)).toBe("new");
    expect(classifyTaskScope("открой почту", REPORT)).toBe("new");
    expect(classifyTaskScope("посчитай смету на ремонт", REPORT)).toBe("new");
    expect(classifyTaskScope("найди рейсы в Сочи", REPORT)).toBe("new");
  });

  it("🔴 КОРОТКИЙ объект тоже объект: «исправь баг» при идущем отчёте → new (адверс-ревью 2026-09-01)", () => {
    // Отсечка длины (`>= 4`) выбрасывала «баг»/«код»/«тон»/«лог»/«чат» → реплика снова считалась
    // правкой отчёта: произнесённое «Принял, поправляю» о работе, которой не было, плюс впрыск
    // инструкции в чужую петлю. Владелец — разработчик, эти слова у него повседневные.
    expect(classifyTaskScope("исправь баг", REPORT)).toBe("new");
    expect(classifyTaskScope("поправь код", REPORT)).toBe("new");
    expect(classifyTaskScope("измени тон", REPORT)).toBe("new");
    expect(classifyTaskScope("добавь лог", REPORT)).toBe("new");
    expect(classifyTaskScope("добавь его в чат", REPORT)).toBe("new"); // «его» — филлер, «чат» — объект
    // …и это НЕ огрубление: короткий объект, совпавший с целью, по-прежнему правка.
    expect(classifyTaskScope("исправь баг", "почини баг в форме логина")).toBe("edit");
    expect(classifyTaskScope("поправь код", "напиши код парсера")).toBe("edit");
    // Чистый модификатор без объекта — правка, как и был (служебные слова объектом не считаются).
    expect(classifyTaskScope("исправь это", REPORT)).toBe("edit");
  });

  it("по умолчанию (без маркеров правки) → new — чтобы отдельная задача запускалась", () => {
    expect(classifyTaskScope("сделай презентацию по проекту", REPORT)).toBe("new");
    expect(classifyTaskScope("", REPORT)).toBe("new");
  });

  it("маркеры ОТКАЗА/редиректа («не то / не так / вместо») → edit (рулёжка текущей задачи)", () => {
    expect(classifyTaskScope("нет, не то", REPORT)).toBe("edit");
    expect(classifyTaskScope("нет блин не то", REPORT)).toBe("edit");
    expect(classifyTaskScope("ты делаешь не так", REPORT)).toBe("edit");
    expect(classifyTaskScope("вместо этого открой сайт", REPORT)).toBe("edit");
    expect(classifyTaskScope("сделай по другому", REPORT)).toBe("edit");
    // бареное «лучше/иначе» НЕ должно ложно ловиться как правка (частотны вне рулёжки)
    expect(classifyTaskScope("лучше закажи такси", REPORT)).toBe("new");
  });

  it("A2 (форензика 2026-07-14): ПРЕТЕНЗИЯ «не сработало/не сделано» при активной задаче → edit (доведи, не новая)", () => {
    // Живой эпизод: «это не сделал», «нихуя не перемотал», «не ушло» уходили scope=new → вторая пустая
    // петля вместо доведения. Теперь — правка текущей задачи (re-verify/добей).
    expect(classifyTaskScope("это не сделал", REPORT)).toBe("edit");
    expect(classifyTaskScope("вот видишь у меня дошло до 35 и ты нихуя не перемотал", DOTA)).toBe("edit");
    expect(classifyTaskScope("Джарвис не ушло", REPORT)).toBe("edit");
    expect(classifyTaskScope("сообщение не отправлено", REPORT)).toBe("edit");
    expect(classifyTaskScope("так и не получилось", REPORT)).toBe("edit");
    // но самостоятельное «не» без претензии к выполненному — не ложный edit
    expect(classifyTaskScope("не забудь про встречу завтра", REPORT)).toBe("new");
  });

  it("A2 (ревью р2 #4): общие «ничего не / так и не» УБРАНЫ — новая команда не проглатывается как правка", () => {
    expect(classifyTaskScope("на завтра ничего не запланировано, покажи календарь", REPORT)).toBe("new");
    expect(classifyTaskScope("так и не решил, закажи такси", REPORT)).toBe("new");
    expect(classifyTaskScope("до сих пор не пойму, открой настройки", REPORT)).toBe("new");
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

describe("looksLikeDoneEcho — эхо-статус сразу после терминала (эпизод «двойная отправка» 2026-07-24)", () => {
  it("живой случай: «Это написал.» через секунду после «Отправил Кате» → эхо, не новая задача", () => {
    expect(looksLikeDoneEcho("Это написал.")).toBe(true);
  });

  it("короткие подтверждения/статусы → эхо", () => {
    expect(looksLikeDoneEcho("готово?")).toBe(true);
    expect(looksLikeDoneEcho("ты отправил")).toBe(true);
    expect(looksLikeDoneEcho("всё, сделано")).toBe(true);
    expect(looksLikeDoneEcho("ну что, ушло?")).toBe(true);
  });

  it("содержательный токен вне allowlist → НЕ эхо (решает модель)", () => {
    expect(looksLikeDoneEcho("написал брату?")).toBe(false);
    expect(looksLikeDoneEcho("теперь напиши ей что сдал")).toBe(false);
    expect(looksLikeDoneEcho("сообщи когда заказ будет доставлен")).toBe(false);
    expect(looksLikeDoneEcho("открой ютуб")).toBe(false);
  });

  it("императив без заявки-прошедшего → НЕ эхо", () => {
    expect(looksLikeDoneEcho("это напиши")).toBe(false); // «напиши» — императив, не заявка «написал»
    expect(looksLikeDoneEcho("отправь это")).toBe(false);
  });

  it("«не» намеренно вне allowlist: претензия «не написал» уходит модели на перепроверку", () => {
    expect(looksLikeDoneEcho("ты не написал")).toBe(false);
    expect(looksLikeDoneEcho("нихуя не отправил")).toBe(false);
  });

  it("длинные фразы (>4 токенов) → НЕ эхо", () => {
    expect(looksLikeDoneEcho("ты это точно уже правда написал")).toBe(false);
    expect(looksLikeDoneEcho("")).toBe(false);
  });
});

