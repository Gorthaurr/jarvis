/**
 * Ambient-источник почты (D-5). Проверяем границы честности (вкладки нет / пусто / не разобрал ≠ «писем
 * нет») и то, что рассылки не будят владельца, а важные отправители — будят.
 */
import { describe, expect, it, vi } from "vitest";
import { createMailSource, looksLikeBulk, mailSignal } from "./mail-source.js";

const NOW = new Date(2026, 6, 29, 12, 0, 0).getTime();

function sourceOf(reply: unknown, opts: Parameters<typeof createMailSource>[2] = {}) {
  const reader = { mailRead: vi.fn(async () => reply) };
  const src = createMailSource(reader, "u1", { now: () => NOW, ...opts });
  return { src, reader };
}

describe("createMailSource", () => {
  it("живое письмо → сигнал выше порога озвучки", async () => {
    const { src } = sourceOf({ ok: true, mail: [{ from: "Бухгалтерия", subject: "Акт за июль" }] });
    const out = await src.poll();
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("Сэр, вам письмо от Бухгалтерия — «Акт за июль».");
    expect(out[0]!.salience).toBeGreaterThan(0.5);
  });

  it("рассылка — НИЖЕ порога (движок её не озвучит), но сигнал не теряется", async () => {
    const { src } = sourceOf({ ok: true, mail: [{ from: "no-reply@shop", subject: "Скидки недели" }] });
    const out = await src.poll();
    expect(out[0]!.salience).toBeLessThan(0.5);
  });

  it("важный отправитель перебивает признак рассылки", async () => {
    const { src } = sourceOf(
      { ok: true, mail: [{ from: "noreply@bank.ru", subject: "Уведомление о платеже" }] },
      { importantSenders: () => ["bank.ru"] },
    );
    expect((await src.poll())[0]!.salience).toBeGreaterThan(0.8);
  });

  // КОНТРОЛЬ-6 (MEDIUM): кап по ПОЗИЦИИ в списке навсегда съедал бюджет первыми строками — важное
  // письмо под тремя рассылками не объявлялось НИКОГДА. Источник отдаёт всё, темп задаёт движок
  // (бюджет озвучек на тик), а неотданное не помечается и вернётся следующим тиком.
  it("источник отдаёт ВСЕ распознанные письма — темп ограничивает движок, а не позиция в списке", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ from: `Отправитель ${i}`, subject: `Тема ${i}` }));
    const { src } = sourceOf({ ok: true, recognized: true, mail: many });
    expect(await src.poll()).toHaveLength(10);
  });

  it("важное письмо ПОД рассылками не голодает: оно есть в сигналах и выше порога", async () => {
    const mail = [
      { from: "no-reply@shop", subject: "Скидки" },
      { from: "newsletter@x", subject: "Дайджест" },
      { from: "promo@y", subject: "Акция" },
      { from: "Бухгалтерия", subject: "Акт сверки, срочно" },
    ];
    const { src } = sourceOf({ ok: true, recognized: true, mail });
    const out = await src.poll();
    const important = out.find((s) => s.title.includes("Бухгалтерия"));
    expect(important).toBeDefined();
    expect(important!.salience).toBeGreaterThan(0.5);
  });

  it("вкладки почты нет → молчим и не лезем", async () => {
    const { src } = sourceOf({ ok: true, noTab: true, mail: [] });
    expect(await src.poll()).toEqual([]);
  });

  it("ЧЕСТНОСТЬ: пустая (выгруженная) вкладка → деградация, а не «писем нет»", async () => {
    const mod = await import("../../obs/metrics.js");
    const spy = vi.spyOn(mod.metrics, "recordDegradation").mockImplementation(() => {});
    const { src } = sourceOf({ ok: false, blank: true });
    expect(await src.poll()).toEqual([]);
    expect(spy).toHaveBeenCalledWith("mail_unreadable", expect.objectContaining({ reason: "blank" }));
    spy.mockRestore();
  });

  it("пустой список писем деградацией не считается (законно пустой ящик)", async () => {
    const mod = await import("../../obs/metrics.js");
    const spy = vi.spyOn(mod.metrics, "recordDegradation").mockImplementation(() => {});
    const { src } = sourceOf({ ok: true, recognized: true, mail: [] });
    expect(await src.poll()).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("ЧЕСТНОСТЬ: вёрстку не узнали → деградация (иначе новая вёрстка Gmail молча убила бы D-5)", async () => {
    const mod = await import("../../obs/metrics.js");
    const spy = vi.spyOn(mod.metrics, "recordDegradation").mockImplementation(() => {});
    const { src } = sourceOf({ ok: true, recognized: false, mail: [], text: "…", host: "mail.google.com" });
    expect(await src.poll()).toEqual([]);
    expect(spy).toHaveBeenCalledWith("mail_layout_unknown", expect.objectContaining({ host: "mail.google.com" }));
    spy.mockRestore();
  });

  it("расширение упало → пропуск тика без падения", async () => {
    const reader = { mailRead: vi.fn(async () => { throw new Error("нет расширения"); }) };
    const src = createMailSource(reader, "u1", { now: () => NOW });
    expect(await src.poll()).toEqual([]);
  });
});

// ФИНАЛЬНОЕ РЕВЬЮ (MEDIUM): инструмент обещал «тело писем НЕ читается», а тянул в промпт innerText
// ВСЕЙ страницы — при открытом письме туда уезжало его тело и цитируемая переписка.
describe("mail_read — приватность и честность декларации", () => {
  const ctxWith = (reply: unknown) =>
    ({ ext: { mailRead: async () => reply } }) as unknown as import("../../brain/tools/dispatch.js").ToolContext;

  it("список распознан → в промпт идёт ТОЛЬКО он, без текста страницы", async () => {
    const { mailRead } = await import("../../brain/tools/handlers/mail.js");
    const res = await mailRead(
      ctxWith({ ok: true, recognized: true, mail: [{ from: "Катя", subject: "Привет" }], host: "mail.google.com" }),
      {},
    );
    expect(res.content).toContain("от Катя");
    expect(res.content).not.toContain("текст страницы");
  });

  // КОНТРОЛЬ-4 (HIGH): «непрочитанных нет» и «вёрстку не узнал» — РАЗНЫЕ исходы. Раньше пустой ящик
  // (самый частый случай) уезжал в облако текстом всей страницы с открытым письмом и ЛОЖНЫМ
  // объяснением «разбор не удался».
  it("вёрстка узнана, писем нет → честное «непрочитанных нет» БЕЗ текста страницы", async () => {
    const { mailRead } = await import("../../brain/tools/handlers/mail.js");
    const res = await mailRead(ctxWith({ ok: true, recognized: true, mail: [], host: "mail.google.com" }), {});
    expect(res.content).toContain("Непрочитанных писем нет");
    expect(res.content).not.toContain("текст страницы");
    expect(res.content).not.toContain("распознать не удалось");
  });

  // КОНТРОЛЬ-10 (MEDIUM): «разобрали строки» ≠ «умеем отличать непрочитанное» — это РАЗНЫЕ семейства
  // селекторов. При промахе маркера получался пустой список и уверенное «писем нет» при полном ящике.
  it("маркер непрочитанного не подтверждён → ответ ОСТОРОЖНЫЙ, а не «писем нет»", async () => {
    const { mailRead } = await import("../../brain/tools/handlers/mail.js");
    const res = await mailRead(
      ctxWith({ ok: true, recognized: true, markerConfident: false, mail: [], host: "e.mail.ru" }),
      {},
    );
    expect(res.content).toContain("мог не распознать");
    expect(res.content).not.toContain("Непрочитанных писем нет.");
  });

  // КОНТРОЛЬ-11 (HIGH): инжектор НАСЧИТАЛ непрочитанные, но полей из них не вытащил → список пуст.
  // Это «вижу, но не прочитал», а не «писем нет»; markerConfident такой случай МАСКИРОВАЛ.
  it("счёт непрочитанных есть, а списка нет → называем ЧИСЛО, а не «писем нет»", async () => {
    const { mailRead } = await import("../../brain/tools/handlers/mail.js");
    const res = await mailRead(
      ctxWith({ ok: true, recognized: true, markerConfident: true, mail: [], unreadTotal: 5, host: "e.mail.ru" }),
      {},
    );
    expect(res.content).toContain("5");
    expect(res.content).not.toContain("Непрочитанных писем нет");
  });

  it("маркер подтверждён и писем нет → прежний уверенный ответ", async () => {
    const { mailRead } = await import("../../brain/tools/handlers/mail.js");
    const res = await mailRead(
      ctxWith({ ok: true, recognized: true, markerConfident: true, mail: [], host: "mail.google.com" }),
      {},
    );
    expect(res.content).toContain("Непрочитанных писем нет");
  });

  it("вёрстка НЕ узнана → текст страницы отдаётся, но С ЧЕСТНЫМ предупреждением о теле письма", async () => {
    const { mailRead } = await import("../../brain/tools/handlers/mail.js");
    const res = await mailRead(
      ctxWith({ ok: true, recognized: false, mail: [], text: "Привет, вот наш договор…", textIsWholePage: true }),
      {},
    );
    expect(res.content).toContain("ТЕКСТ ВСЕЙ СТРАНИЦЫ");
    expect(res.content).toContain("тело не пересказывай");
    expect(res.content).toContain("<untrusted_content"); // M11: письмо — данные, не приказ
  });

  it("вкладки нет → честный отказ, а НЕ «писем нет»", async () => {
    const { mailRead } = await import("../../brain/tools/handlers/mail.js");
    const res = await mailRead(ctxWith({ ok: true, noTab: true, mail: [] }), {});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("не открыта");
  });
});

describe("mailSignal / looksLikeBulk", () => {
  it("ключ стабилен для одного письма — второй раз не объявим", () => {
    const item = { from: "Катя", subject: "Привет" };
    expect(mailSignal(item, "u1", NOW, [])!.key).toBe(mailSignal(item, "u1", NOW + 60_000, [])!.key);
  });

  it("письмо без отправителя и темы сигналом не становится", () => {
    expect(mailSignal({ from: " ", subject: "" }, "u1", NOW, [])).toBeNull();
  });

  it("распознаём массовые рассылки", () => {
    expect(looksLikeBulk({ from: "newsletter@x", subject: "Дайджест" })).toBe(true);
    expect(looksLikeBulk({ from: "Мама", subject: "Позвони" })).toBe(false);
  });
});
