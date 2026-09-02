/**
 * Наблюдение-ДЕЛЬТА: «что изменилось», а не «как выглядит окно».
 *
 * Корень (форензика 2026-09-01): fused act+observe отдавал ОПИСАНИЕ окна, которое не отвечает на
 * вопрос verify-долга «изменилось ли то, что я хотел» — и модель добирала уверенность скриншотом.
 * В логах это видно прямо: пара `screen_capture → input_click` — самая частая во всём датасете
 * (57 раз), 41% раундов с кликом требовали скрина следующим раундом, `ui_snapshot` — 0 вызовов
 * из 973 при 156 скриншотах.
 *
 * Ключевой честностный инвариант здесь — ВОЛАТИЛЬНОСТЬ: у плеера строка таймера меняется сама,
 * без нашего действия. Без её фильтра каждое наблюдение над видео возвращало бы «изменилось» и
 * выдавало ход времени за результат клика (ложный успех в новой упаковке).
 */
import { describe, expect, it } from "vitest";
import { diffFingerprints, formatDelta, normalizeVolatile, splitDigest } from "./observe.js";

const fp = (lines: string[], title?: string) => ({ title, lines });

describe("splitDigest", () => {
  it("режет выжимку на строки-элементы и выбрасывает пустые", () => {
    expect(splitDigest("Button: Отправить\n\n  Edit: [привет]  \n")).toEqual(["Button: Отправить", "Edit: [привет]"]);
  });
});

describe("diffFingerprints", () => {
  it("видит появившийся и исчезнувший элемент", () => {
    const d = diffFingerprints(fp(["Button: Отмена", "Text: Заголовок"]), fp(["Text: Заголовок", "Button: Отправить"]));
    expect(d.appeared).toEqual(["Button: Отправить"]);
    expect(d.disappeared).toEqual(["Button: Отмена"]);
    expect(d.changed).toBe(true);
  });

  it("видит изменение значения поля (ввод текста)", () => {
    const d = diffFingerprints(fp(["Edit: Сообщение [ПУСТО]"]), fp(["Edit: Сообщение [привет]"]));
    expect(d.changed).toBe(true);
    expect(d.appeared).toEqual(["Edit: Сообщение [привет]"]);
  });

  it("ничего не изменилось → changed:false (клик, возможно, не дошёл)", () => {
    const same = ["Button: Играть", "Text: Меню"];
    expect(diffFingerprints(fp(same), fp([...same])).changed).toBe(false);
  });

  it("🔴 таймер плеера сам по себе НЕ считается изменением", () => {
    const d = diffFingerprints(fp(["Text: 7:28", "Button: Пауза"]), fp(["Text: 7:31", "Button: Пауза"]));
    expect(d.appeared).toEqual(["Text: 7:31"]);
    expect(d.volatileOnly).toBe(true);
    expect(d.changed).toBe(false);
  });

  it("но настоящее изменение рядом с таймером — считается", () => {
    const d = diffFingerprints(
      fp(["Text: 7:28", "Button: Пауза"]),
      fp(["Text: 7:31", "Button: Воспроизвести"]),
    );
    expect(d.changed).toBe(true);
    expect(d.volatileOnly).toBe(false);
  });

  it("смена заголовка окна — изменение даже без правок в дереве", () => {
    const d = diffFingerprints(fp(["Text: одно"], "Блокнот"), fp(["Text: одно"], "Блокнот — сохранено"));
    expect(d.changed).toBe(true);
    expect(d.titleFrom).toBe("Блокнот");
    expect(d.titleTo).toBe("Блокнот — сохранено");
  });

  it("повторяющиеся строки считаются мультимножеством (одна из трёх исчезла — это видно)", () => {
    const d = diffFingerprints(fp(["Item: письмо", "Item: письмо", "Item: письмо"]), fp(["Item: письмо", "Item: письмо"]));
    expect(d.disappeared).toEqual(["Item: письмо"]);
    expect(d.appeared).toEqual([]);
    expect(d.changed).toBe(true);
  });
});

describe("normalizeVolatile", () => {
  it("схлопывает цифровые серии", () => {
    expect(normalizeVolatile("Text: 12:07 / 45:00")).toBe(normalizeVolatile("Text: 3:59 / 45:00"));
    expect(normalizeVolatile("Button: Отправить")).toBe("Button: Отправить");
  });
});

describe("formatDelta", () => {
  it("пустая дельта объясняет, что это НЕ доказательство ни успеха, ни провала", () => {
    const text = formatDelta(diffFingerprints(fp(["A: 1"]), fp(["A: 1"])));
    expect(text).toContain("НЕ ВИДНО");
    expect(text).toMatch(/не доказывает ни успех, ни провал/i);
  });

  it("показывает изменения знаками + и −", () => {
    const text = formatDelta(diffFingerprints(fp(["Button: Отмена"]), fp(["Button: Отправить"])));
    expect(text).toContain("+ Button: Отправить");
    expect(text).toContain("− Button: Отмена");
  });

  it("волатильная дельта помечается предупреждением", () => {
    const text = formatDelta(diffFingerprints(fp(["Text: 1:00"]), fp(["Text: 1:01"])));
    expect(text).toMatch(/только числа/i);
  });

  it("длинный список усекается честной пометкой, а не молча", () => {
    const before = fp([]);
    const after = fp(Array.from({ length: 25 }, (_, i) => `Item: строка ${i}`));
    const text = formatDelta(diffFingerprints(before, after));
    expect(text).toMatch(/и ещё \d+/);
  });
});

describe("сопоставимость снимков (адверс-ревью: HIGH)", () => {
  it("🔴 фокус уехал в другое поддерево — это НЕ сверка, сколько бы строк ни «изменилось»", () => {
    // read.window читает поддерево ЭЛЕМЕНТА С ФОКУСОМ: после клика корень выжимки может смениться,
    // и разница двух РАЗНЫХ деревьев выглядела как мощнейшее подтверждение исхода.
    const d = diffFingerprints(
      fp(["Edit: Сообщение [привет]", "Text: черновик", "Text: подпись", "Button: Смайл", "Button: Скрепка"]),
      fp(["List: Чат", "Text: вчера", "Text: сегодня", "Text: позавчера", "Text: на той неделе"]),
    );
    expect(d.comparable).toBe(false);
    expect(d.changed).toBe(false);
    expect(formatDelta(d)).toMatch(/СРАВНИВАТЬ НЕ С ЧЕМ/);
  });

  it("перерисовка внутри окна (каркас цел) остаётся сопоставимой", () => {
    const frame = ["MenuBar: Файл", "StatusBar: Готово", "Text: Документ"];
    const d = diffFingerprints(fp([...frame, "Button: Отмена"]), fp([...frame, "Button: Отправить"]));
    expect(d.comparable).toBe(true);
    expect(d.changed).toBe(true);
  });

  it("🔴 таймер в ЗАГОЛОВКЕ не пробивает фильтр волатильности", () => {
    // Был путь: заголовок сравнивался сырым → «7:28 — VLC» → «7:31 — VLC» давало changed:true,
    // и промахнувшийся клик по паузе получал снятие verify-долга.
    const d = diffFingerprints(fp(["Text: 7:28"], "7:28 — VLC"), fp(["Text: 7:31"], "7:31 — VLC"));
    expect(d.volatileOnly).toBe(true);
    expect(d.changed).toBe(false);
  });


  it("🔴 таймер ТОЛЬКО в заголовке (дерево не менялось) — не изменение", () => {
    // Отдельный случай: строки окна идентичны, тикает лишь часы/таймер в титуле. Тогда фильтр
    // волатильности строк не срабатывает вовсе (appeared пуст), и решает ИМЕННО сравнение
    // заголовка. Сырое сравнение давало changed:true — ход времени засчитывался сверкой исхода.
    const lines = ["Button: Пауза", "Text: Название ролика"];
    const d = diffFingerprints(fp(lines, "7:28 — VLC"), fp([...lines], "7:31 — VLC"));
    expect(d.appeared).toEqual([]);
    expect(d.changed).toBe(false);
  });

  it("настоящая смена заголовка (не числа) — изменение", () => {
    const d = diffFingerprints(fp(["Text: одно"], "Блокнот"), fp(["Text: одно"], "Блокнот — сохранено"));
    expect(d.changed).toBe(true);
  });

  it("числовой результат (перемотка/страница) НЕ объявляется «структура не изменилась»", () => {
    const text = formatDelta(diffFingerprints(fp(["Text: Стр. 1 из 10"]), fp(["Text: Стр. 2 из 10"])));
    expect(text).toMatch(/изменились только ЧИСЛА/);
    expect(text).toMatch(/может быть и таймер сам по себе, и результат/);
  });
});

describe("ИЗМЕРЕННАЯ волатильность (замер вместо догадки по цифрам)", () => {
  it("таймер, замеченный как самоизменяющийся, — фон: changed:false", () => {
    const before = { title: "VLC", lines: ["Text: 7:28", "Button: Пауза"], selfChanging: ["Text: #:#"] };
    const d = diffFingerprints(before, fp(["Text: 7:31", "Button: Пауза"], "VLC"));
    expect(d.volatileOnly).toBe(true);
    expect(d.changed).toBe(false);
  });

  it("🔴 номер страницы САМ не менялся → это РЕЗУЛЬТАТ действия, а не фон", () => {
    // Лексическое правило гасило этот случай («поменялись только цифры») и объявляло сработавший
    // переход на следующую страницу не дошедшим до цели.
    // Замер СОСТОЯЛСЯ: часы в окне тикали сами, а строка страницы — нет. Значит её изменение наше.
    const before = { title: "Каталог", lines: ["Text: Стр. 1 из 10", "Text: 14:03", "Button: Дальше"], selfChanging: ["Text: #:#"] };
    const d = diffFingerprints(before, fp(["Text: Стр. 2 из 10", "Text: 14:03", "Button: Дальше"], "Каталог"));
    expect(d.volatileOnly).toBe(false);
    expect(d.changed).toBe(true);
  });

  it("сумма в поле — тоже результат, а не фон", () => {
    const before = { title: "Форма", lines: ["Edit: Сумма [100]", "Text: 14:03"], selfChanging: ["Text: #:#"] };
    expect(diffFingerprints(before, fp(["Edit: Сумма [1000]", "Text: 14:03"], "Форма")).changed).toBe(true);
  });

  it("часы тикают, а кнопка появилась — изменение засчитано", () => {
    const before = { title: "Окно", lines: ["Text: 14:03", "Text: Меню"], selfChanging: ["Text: #:#"] };
    const d = diffFingerprints(before, fp(["Text: 14:04", "Text: Меню", "Button: Готово"], "Окно"));
    expect(d.changed).toBe(true);
  });

  it("замера нет (второе чтение не удалось) → прежняя лексическая эвристика", () => {
    const d = diffFingerprints(fp(["Text: 7:28"]), fp(["Text: 7:31"]));
    expect(d.volatileOnly).toBe(true);
    expect(d.changed).toBe(false);
  });
});

describe("находки адверс-ревью (партия 2)", () => {
  it("🔴 ПУСТОЙ замер не отменяет фильтр таймера: тик остаётся фоном", () => {
    // Проба 160мс короче секундного тика и чаще всего его НЕ ловит. Раньше пустой массив считался
    // полноценным замером «тут ничего не тикает» и ОТКЛЮЧАЛ лексический гард — следующий же тик
    // засчитывался изменением и снимал verify-долг с промахнувшегося клика.
    const before = { title: "VLC", lines: ["Text: 7:28", "Button: Пауза", "Text: Ролик", "Text: Канал"], selfChanging: [] };
    const d = diffFingerprints(before, fp(["Text: 7:29", "Button: Пауза", "Text: Ролик", "Text: Канал"], "VLC"));
    expect(d.volatileOnly).toBe(true);
    expect(d.changed).toBe(false);
  });

  it("но НЕПУСТОЙ замер по-прежнему различает номер страницы и таймер", () => {
    const before = { title: "Каталог", lines: ["Text: Стр. 1 из 10", "Text: 14:03"], selfChanging: ["Text: #:#"] };
    const d = diffFingerprints(before, fp(["Text: Стр. 2 из 10", "Text: 14:04"], "Каталог"));
    expect(d.changed).toBe(true); // страница поменялась — это результат действия
  });

  it("🔴 смена ПЕРЕДНЕГО окна не выдаётся за изменение наблюдаемого (строки идентичны)", () => {
    // Заголовок теперь берётся у окна наблюдаемого pid; если он не менялся — и дельты нет.
    const lines = ["Button: Отправить", "Edit: Сообщение [привет]", "Text: чат", "Text: вчера"];
    const d = diffFingerprints(fp(lines, "Telegram"), fp([...lines], "Telegram"));
    expect(d.changed).toBe(false);
  });
});
