// Сверка «ушло ли на самом деле» перед повтором отправки (эпизод «Катя получила дубль», 2026-08-31).
import { describe, expect, it } from "vitest";
import { findOwnMessage, probeDelivery, verdictFromReadback } from "./delivery-check.js";

describe("findOwnMessage — своё сообщение в ленте чата", () => {
  const own = { dir: "out", text: "Буду к семи, не жди с ужином" };

  it("находит своё исходящее по точному тексту", () => {
    expect(findOwnMessage([{ dir: "in", text: "ок" }, own], "Буду к семи, не жди с ужином")).toBe(true);
  });

  it("терпит различия пунктуации/регистра (нормализация как у ресенд-гарда)", () => {
    expect(findOwnMessage([own], "буду к семи не жди с ужином!")).toBe(true);
  });

  it("ВХОДЯЩЕЕ с тем же текстом не считается нашей отправкой", () => {
    expect(findOwnMessage([{ dir: "in", text: "Буду к семи, не жди с ужином" }], "Буду к семи, не жди с ужином")).toBe(false);
  });

  it("другое исходящее — не наше сообщение", () => {
    expect(findOwnMessage([{ dir: "out", text: "куплю хлеб" }], "буду к семи")).toBe(false);
  });

  // Асимметрия цены: ложное «доставлено» молча теряет сообщение, поэтому короткий текст сверяется целиком.
  it("короткий текст не матчится подстрокой («да» внутри «да, конечно»)", () => {
    expect(findOwnMessage([{ dir: "out", text: "да, конечно" }], "да")).toBe(false);
    expect(findOwnMessage([{ dir: "out", text: "да" }], "да")).toBe(true);
  });

  it("длинный текст засчитывается и как вхождение (пузырь может нести хвост мета)", () => {
    expect(findOwnMessage([{ dir: "out", text: "перезвоню после обеда изменено" }], "перезвоню после обеда")).toBe(true);
  });

  it("пустой текст никогда не считается доставленным", () => {
    expect(findOwnMessage([{ dir: "out", text: "" }], "")).toBe(false);
  });
});

describe("verdictFromReadback — «не смог посмотреть» ≠ «сообщения нет»", () => {
  it("чтение не вышло → unknown", () => {
    expect(verdictFromReadback({ ok: false }, "привет")).toBe("unknown");
  });

  it("формат не распознан (messages не массив) → unknown, а не absent", () => {
    expect(verdictFromReadback({ ok: true, messages: "нет данных" }, "привет")).toBe("unknown");
  });

  it("чат прочитан, своего сообщения нет → absent (повтор законен)", () => {
    expect(verdictFromReadback({ ok: true, messages: [{ dir: "in", text: "ок" }] }, "привет")).toBe("absent");
  });

  it("чат прочитан, сообщение на месте → delivered", () => {
    expect(verdictFromReadback({ ok: true, messages: [{ dir: "out", text: "привет" }] }, "привет")).toBe("delivered");
  });
});

describe("probeDelivery", () => {
  it("исключение при чтении → unknown (никогда не «не ушло»)", async () => {
    expect(await probeDelivery("привет", async () => { throw new Error("CDP умер"); })).toBe("unknown");
  });

  it("успешное чтение → вердикт по содержимому", async () => {
    expect(await probeDelivery("привет", async () => ({ ok: true, messages: [{ dir: "out", text: "привет" }] }))).toBe("delivered");
  });
});

// 🔴 Урок слепой вкладки (watch): молчащий сенсор не должен маскироваться под честное «ещё нет».
describe("пустой чат — это «не увидел», а не «сообщения нет»", () => {
  it("ноль сообщений → unknown (иначе фолбэк отправит второе сообщение человеку)", () => {
    expect(verdictFromReadback({ ok: true, messages: [] }, "привет")).toBe("unknown");
  });

  it("непустой чат без нашего сообщения по-прежнему absent (повтор законен)", () => {
    expect(verdictFromReadback({ ok: true, messages: [{ dir: "in", text: "ок" }] }, "привет")).toBe("absent");
  });
});

/**
 * 🔴 Ревью волны I: клиент отдаёт текст пузыря ОБРЕЗАННЫМ (500 символов) и срезает хвостовое время,
 * поэтому строгое равенство объявляло реально отправленные сообщения неотправленными → дубль человеку.
 */
describe("сверка терпит обрезку пузыря, но не путает старые сообщения с новыми", () => {
  it("«буду в 19:30» найдено, хотя время срезано чисткой клиента", () => {
    expect(verdictFromReadback({ ok: true, messages: [{ dir: "out", text: "буду в" }] }, "буду в 19:30")).toBe("delivered");
  });

  it("длинное сообщение, обрезанное до 500 символов, засчитывается по началу", () => {
    const long = `Отчёт по рынку за неделю: ${"деталь ".repeat(120)}`;
    expect(verdictFromReadback({ ok: true, messages: [{ dir: "out", text: long.slice(0, 500) }] }, long)).toBe("delivered");
  });

  it("короткий текст обрезкой не оправдывается — только точное совпадение", () => {
    expect(verdictFromReadback({ ok: true, messages: [{ dir: "out", text: "да" }] }, "да, буду")).toBe("absent");
  });

  it("совпадение ГЛУБОКО в истории не считается доставкой (иначе потеря сообщения под отчёт об успехе)", () => {
    const old = { dir: "out", text: "еду домой" };
    const recent = [{ dir: "in", text: "ок" }, { dir: "in", text: "жду" }, { dir: "out", text: "буду позже" }, { dir: "in", text: "ага" }];
    expect(verdictFromReadback({ ok: true, messages: [old, ...recent] }, "еду домой")).toBe("absent");
  });

  it("только что отправленное (в хвосте ленты) — доставлено", () => {
    expect(verdictFromReadback({ ok: true, messages: [{ dir: "in", text: "ты где?" }, { dir: "out", text: "еду домой" }] }, "еду домой")).toBe("delivered");
  });
});
