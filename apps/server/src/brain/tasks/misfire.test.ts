// Волна H: самоотмена ЛОЖНОГО запуска — «это не призыв к действию был» (живой эпизод владельца).
import { describe, expect, it } from "vitest";
import { describeIrreversible, irreversibleDone, looksLikeMisfire, misfireAck } from "./misfire.js";

describe("looksLikeMisfire — распознаём «ты принял мои слова за команду»", () => {
  it.each([
    "Джарвис, это не призыв к действию был",
    "это не команда",
    "я тебя не просил",
    "я этого не просил",
    "тебя никто не просил",
    "ты неправильно понял",
    "я не к тебе обращался",
    "это не тебе",
    "я просто размышлял вслух",
  ])("ловит: %s", (t) => {
    expect(looksLikeMisfire(t)).toBe(true);
  });

  // Позитивный allowlist: всё, что не является явным «это была не команда», уходит модели.
  it.each([
    "отмени задачу", // обычная отмена — её обрабатывает classifyTaskControl
    "не то место, левее", // ПОПРАВКА курса (steer), а не отмена — ломать нельзя
    "не так быстро",
    "напиши Кате, что я не просил её приходить", // «не просил» ВНУТРИ поручения
    "просил же тебя сделать отчёт",
    "это команда для дрона",
  ])("НЕ ловит: %s", (t) => {
    expect(looksLikeMisfire(t)).toBe(false);
  });
});

describe("misfireAck — честный текст самоотмены", () => {
  it("нечего останавливать → признаём ошибку понимания, но ничего не обещаем", () => {
    const s = misfireAck(0);
    expect(s).toContain("не было поручением");
    expect(s).not.toContain("Остановил");
  });

  it("остановлено — говорим сколько", () => {
    expect(misfireAck(1)).toContain("Остановил");
    expect(misfireAck(3)).toContain("(3)");
  });

  // 🔴 ГЛАВНЫЙ инвариант: остановка задачи НЕ отменяет отправленного. Молчать об этом = ложный отчёт.
  it("если сообщение уже ушло — говорим прямо, а не рапортуем чистую отмену", () => {
    const s = misfireAck(1, ["сообщение «Катя» в Telegram уже отправлено"]);
    expect(s).toContain("вернуть уже сделанное не могу");
    expect(s).toContain("Катя");
  });

  it("много необратимого — показываем первые, не заваливаем голосом", () => {
    const s = misfireAck(1, ["а", "б", "в", "г", "д"]);
    expect(s.split(";").length).toBeLessThanOrEqual(3);
  });
});

describe("describeIrreversible / irreversibleDone", () => {
  it("описывает отправки и заказы по-человечески, с адресатом", () => {
    expect(describeIrreversible("telegram_send", { to: "Катя" })).toContain("Катя");
    expect(describeIrreversible("telegram_send", { to: "Катя" })).toContain("Telegram");
    expect(describeIrreversible("order_place", { vendor: "Пятёрочка" })).toContain("заказ");
    expect(describeIrreversible("message_send", {})).toContain("отправлено");
  });

  it("незнакомый инструмент — общее, но честное описание", () => {
    expect(describeIrreversible("fs_delete", { path: "x" })).toContain("fs_delete");
  });

  it("задача без необратимого → пустой список (нечего докладывать)", () => {
    expect(irreversibleDone({})).toEqual([]);
    expect(irreversibleDone({ irreversibleDone: ["отправлено"] })).toEqual(["отправлено"]);
  });
});
