import { describe, expect, it } from "vitest";
import {
  type Candidate,
  bearsName,
  classifyKind,
  foldName,
  latinToCyrillic,
  nameSearchVariants,
  pickRecipient,
  scoreCandidate,
  scriptOf,
  transliterate,
} from "./name-match.js";

describe("foldName", () => {
  it("регистр/пробелы/диакритика/ё", () => {
    expect(foldName("  Herman  ")).toBe("herman");
    expect(foldName("Renée")).toBe("renee");
    expect(foldName("Алёна")).toBe("алена");
    expect(foldName('"Катя"')).toBe("катя");
    expect(foldName("Иван   Петров")).toBe("иван петров");
  });
});

describe("scriptOf", () => {
  it("определяет алфавит", () => {
    expect(scriptOf("Герман")).toBe("cyr");
    expect(scriptOf("Herman")).toBe("lat");
    expect(scriptOf("Den4ik")).toBe("lat");
    expect(scriptOf("Ваня Cool")).toBe("mixed");
  });
});

describe("transliterate (recall, не решение)", () => {
  it("Герман → варианты содержат и german, и herman (Г↔H)", () => {
    const v = transliterate("Герман").map((s) => s.toLowerCase());
    expect(v).toContain("german");
    expect(v).toContain("herman"); // ключ всего фикса
  });

  it("Herman → варианты содержат герман (обратное H→Г)", () => {
    const v = transliterate("Herman").map((s) => s.toLowerCase());
    expect(v).toContain("герман");
  });

  it("Женя → zhenya и jenya", () => {
    const v = transliterate("Женя").map((s) => s.toLowerCase());
    expect(v).toContain("zhenya");
    expect(v).toContain("jenya");
  });

  it("капается и не пустой на латинице/кириллице", () => {
    expect(transliterate("Александр").length).toBeLessThanOrEqual(6);
    expect(transliterate("Александр").length).toBeGreaterThan(0);
  });

  it("смешанный/пустой → пусто", () => {
    expect(transliterate("")).toEqual([]);
    expect(transliterate("Ваня Cool")).toEqual([]);
  });
});

describe("latinToCyrillic (канонизация STT-обрывков, Волна 1 2026-07-10)", () => {
  it("латиница → кириллица primary-рендерингом, диграфы сперва", () => {
    expect(latinToCyrillic("dota")).toBe("дота");
    expect(latinToCyrillic("zhenya")).toBe("женя");
  });

  it("микс латиница+кириллица (живой случай «dotе») — латинские буквы сведены, кириллица цела", () => {
    expect(latinToCyrillic("dotе")).toBe("доте"); // d-o-t латиница + «е» кириллица
  });

  it("чистая кириллица/пусто — как есть (lower)", () => {
    expect(latinToCyrillic("Доте")).toBe("доте");
    expect(latinToCyrillic("")).toBe("");
  });
});

describe("nameSearchVariants", () => {
  it("оригинал первым + транслит, деуплик, кап", () => {
    const v = nameSearchVariants("Герман");
    expect(v[0]).toBe("Герман");
    expect(v.map((s) => s.toLowerCase())).toContain("herman");
    expect(v.length).toBeLessThanOrEqual(5);
  });
  it("пустой запрос → пусто", () => {
    expect(nameSearchVariants("   ")).toEqual([]);
  });
});

describe("scoreCandidate", () => {
  it("точное в одном алфавите = 100, same-script", () => {
    expect(scoreCandidate("Катя", "Катя")).toEqual({ score: 100, sameScript: true });
  });
  it("кросс-скрипт Герман↔Herman — высокий балл, НО sameScript=false", () => {
    const r = scoreCandidate("Герман", "Herman");
    expect(r.sameScript).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(70);
  });
  it("нет связи → 0", () => {
    expect(scoreCandidate("Герман", "Светлана").score).toBe(0);
  });
});

describe("pickRecipient — РЕШЕНИЕ (recall vs решение)", () => {
  const c = (title: string, preview?: string): Candidate => ({ title, preview });

  it("эталон: «Герман», единственный латинский «Herman» → SEND Herman (один транслит-кандидат)", () => {
    const r = pickRecipient("Герман", [c("Herman", "превед")]);
    expect(r.action).toBe("send");
    expect(r.title).toBe("Herman");
  });

  it("«Герман» + и Herman, и German Petrov → ASK (модель решает по смыслу)", () => {
    const r = pickRecipient("Герман", [c("Herman"), c("German Petrov")]);
    expect(r.action).toBe("ask");
    expect(r.ranked.length).toBeGreaterThanOrEqual(2);
  });

  it("один и тот же алфавит, точное при ТЁЗКЕ → ASK (§P1: раньше exact слал и это дало «не ту Катю»)", () => {
    // «Катя» и «Катя из зала» — двое носят запрошенное имя; форензика 2026-07-14: авто-отправка по
    // точному совпадению ушла не тому человеку. Теперь при тёзках спрашиваем владельца.
    const r = pickRecipient("Катя", [c("Катя"), c("Катя из зала")]);
    expect(r.action).toBe("ask");
    expect(r.reason).toBe("namesakes");
  });

  it("один и тот же алфавит, точное БЕЗ тёзок → SEND", () => {
    const r = pickRecipient("Катя", [c("Катя"), c("Олег")]);
    expect(r.action).toBe("send");
    expect(r.title).toBe("Катя");
  });

  it("несколько одинаково-уверенных в одном алфавите → ASK", () => {
    const r = pickRecipient("Маша", [c("Маша"), c("Маша")]);
    expect(r.action).toBe("ask");
  });

  it("нет совпадений → NONE", () => {
    expect(pickRecipient("Герман", [c("Светлана"), c("Олег")]).action).toBe("none");
  });

  it("пустой список → NONE", () => {
    expect(pickRecipient("Герман", []).action).toBe("none");
  });

  it("ranked отсортирован по убыванию score", () => {
    const r = pickRecipient("Саша", [c("Саша Большой"), c("Саша")]);
    expect(r.ranked[0]!.score).toBeGreaterThanOrEqual(r.ranked[1]!.score);
  });

  it("НЕ авто-отправляет, когда транслит даёт двух кандидатов (German и Herman оба точные транслиты)", () => {
    // оба — точные транслит-формы «Герман» → неоднозначно → ask
    const r = pickRecipient("Герман", [c("German"), c("Herman")]);
    expect(r.action).toBe("ask");
  });
});

describe("classifyKind (peerId-знак: рандом-паблик ≠ контакт)", () => {
  it("отрицательный peerId → канал/группа", () => {
    expect(classifyKind({ title: "Gran Hermano", peerId: "-1454637651" })).toBe("channel");
  });
  it("положительный peerId → пользователь", () => {
    expect(classifyKind({ title: "Herman", peerId: "8509637953" })).toBe("user");
  });
  it("явный kind важнее знака; без peerId → unknown", () => {
    expect(classifyKind({ title: "x", kind: "bot", peerId: "-1" })).toBe("bot");
    expect(classifyKind({ title: "x" })).toBe("unknown");
  });
});

describe("pickRecipient: ищем в МОИХ переписках, паблики игнорируем", () => {
  const person = (title: string, peerId: string, mine = false): Candidate => ({ title, peerId, mine });
  const channel = (title: string, peerId: string): Candidate => ({ title, peerId });

  it("эталон по DOM: «Герман» → мой личный Herman (peerId+), а не канал Gran Hermano (peerId−)", () => {
    const r = pickRecipient("Герман", [
      person("Herman", "8509637953", true), // мой диалог (@doroninh)
      channel("Gran Hermano", "-1454637651"), // публичный канал 3796 subs
    ]);
    expect(r.action).toBe("send");
    expect(r.title).toBe("Herman");
    expect(r.peerId).toBe("8509637953"); // стабильный ключ для памяти/точного открытия
  });

  it("мой диалог Herman бьёт глобального @HermanBot (оба user, но mine приоритетнее)", () => {
    const r = pickRecipient("Герман", [
      person("@Herman", "520097525", false), // глобальный бот
      person("Herman", "8509637953", true), // мой диалог
    ]);
    expect(r.action).toBe("send");
    expect(r.peerId).toBe("8509637953");
  });

  it("совпал ТОЛЬКО публичный канал → none (не шлём в рандом-паблик как человеку)", () => {
    const r = pickRecipient("Германия", [channel("Германия", "-1001234567890")]);
    expect(r.action).toBe("none");
  });

  it("без peerId (unknown): тёзки распознаются и тут → ask/namesakes (§P1); одиночное точное — send", () => {
    const namesakes = pickRecipient("Катя", [{ title: "Катя" }, { title: "Катя из зала" }]);
    expect(namesakes.action).toBe("ask");
    expect(namesakes.reason).toBe("namesakes");
    const single = pickRecipient("Катя", [{ title: "Катя" }, { title: "Олег" }]);
    expect(single.action).toBe("send");
    expect(single.title).toBe("Катя");
  });
});

describe("pickRecipient — тёзки (§P1, форензика 2026-07-14 «не та Катя»)", () => {
  const mine = (title: string, peerId: string): Candidate => ({ title, peerId, mine: true, kind: "user" });

  it("точная «Катя» + префиксная «Катя Любимая» → ask/namesakes (exact больше не бьёт тёзок)", () => {
    // Живой эпизод: «напиши кате…» ушло НЕ ТОЙ Кате — точное совпадение авто-отправляло, хотя
    // короткое имя носят двое. Теперь решает владелец.
    const r = pickRecipient("катя", [mine("Катя", "1"), mine("Катя Любимая", "2")]);
    expect(r.action).toBe("ask");
    expect(r.reason).toBe("namesakes");
  });

  it("две «Кати …» без точной → ask/namesakes", () => {
    const r = pickRecipient("катя", [mine("Катя Иванова", "1"), mine("Катя Петрова", "2")]);
    expect(r.action).toBe("ask");
    expect(r.reason).toBe("namesakes");
  });

  it("ревью р1 #5/#10: СМЕШАННЫЙ пул «Катя»(кир)+«Katya Beloved»(лат) → ask/namesakes (кросс-скрипт тёзка)", () => {
    const r = pickRecipient("катя", [mine("Катя", "1"), mine("Katya Beloved", "2")]);
    expect(r.action).toBe("ask");
    expect(r.reason).toBe("namesakes");
  });

  it("ревью р1 #12/#17: имя не в начале («Мама Катя»/«Любимая Катя») → ask/namesakes (word-inclusion)", () => {
    expect(pickRecipient("катя", [mine("Катя", "1"), mine("Мама Катя", "2")]).reason).toBe("namesakes");
    expect(pickRecipient("катя", [mine("Катя", "1"), mine("Любимая Катя", "2")]).reason).toBe("namesakes");
  });

  it("ревью р1 #11: обе латинские тёзки «Katya»+«Katya Rabota» на «катя» → namesakes (не догадка модели)", () => {
    const r = pickRecipient("катя", [mine("Katya", "1"), mine("Katya Rabota", "2")]);
    expect(r.reason).toBe("namesakes");
  });

  it("ПОЛНОЕ имя с точным чатом при короткой тёзке → send (регрессии exact-приоритета нет)", () => {
    // Владелец сказал полное имя — оно однозначно; короткий чат «Катя» его целиком НЕ носит.
    const r = pickRecipient("катя иванова", [mine("Катя Иванова", "1"), mine("Катя", "2")]);
    expect(r.action).toBe("send");
    expect(r.title).toBe("Катя Иванова");
  });

  it("единственная точная «Катя» без тёзок → send как раньше", () => {
    const r = pickRecipient("катя", [mine("Катя", "1"), mine("Пётр", "2")]);
    expect(r.action).toBe("send");
    expect(r.title).toBe("Катя");
  });

  it("«Герман»→единственный Herman (транслит), без тёзки → send", () => {
    const r = pickRecipient("герман", [mine("Herman", "1"), mine("Олег", "2")]);
    expect(r.action).toBe("send");
    expect(r.title).toBe("Herman");
  });

  it("bearsName: имя в любой позиции/алфавите — носитель; чужое (Катерина/Катюша) — нет", () => {
    for (const t of ["Катя", "Катя Любимая", "Мама Катя", "Katya", "Katya Beloved"])
      expect(bearsName("катя", t), t).toBe(true);
    for (const t of ["Катерина", "Катюша", "Пётр", "Катенька"])
      expect(bearsName("катя", t), t).toBe(false);
  });
});
