/**
 * OCR-наблюдение на UIA-СЛЕПОМ окне (игра/canvas) — сверка «до/после», а не описание окрестности.
 *
 * 🔴 Корень (разбор эпизода «Дота» 2026-09-02, HIGH; подтверждён двумя независимыми линзами):
 * ступень OCR возвращала распознанный текст рядом с точкой клика и НЕ ставила `weak` — а сервер
 * считает `observed = weak !== true` и этим гасит verify-долг. Значит любой кусок HUD засчитывался
 * как «сверил исход»: 31 клик подряд «наблюдался», хотя экран между ними не менялся вовсе
 * (две пары кропов дня совпали по размеру байт в байт).
 */
import { describe, expect, it, vi } from "vitest";

const request = vi.fn(async () => ({ text: "" })); // a11y пуст → окно UIA-слепое, идём в OCR
vi.mock("./sidecar-client.js", () => ({ sidecar: () => ({ ready: true, request }) }));

const screenOcr = vi.fn(async () => ({ text: "" }) as { text: string });
vi.mock("./sensors-cheap.js", () => ({ screenOcr }));

const { observeAfterAction, captureUiFingerprint, ocrSkeleton, compareOcr, nearSameWord } = await import("./observe.js");

const POINT = { x: 800, y: 450 };

describe("ocrSkeleton (чистая)", () => {
  it("цифры и пробелы не считаются изменением, буквы — считаются", () => {
    expect(ocrSkeleton("Золото 1234")).toBe(ocrSkeleton("золото   5678"));
    expect(ocrSkeleton("ИГРАТЬ")).not.toBe(ocrSkeleton("ОТМЕНА"));
  });
});

describe("OCR-наблюдение: слабое без сравнения, честное — со сравнением", () => {
  it("экран НЕ изменился → наблюдение СЛАБОЕ (verify-долг не снимается)", async () => {
    screenOcr.mockResolvedValue({ text: "ИГРАТЬ  Золото 1200" });
    const before = await captureUiFingerprint(POINT);
    expect(before?.ocr).toBeTruthy(); // снимок «до» на слепом окне снят по точке действия
    screenOcr.mockResolvedValue({ text: "ИГРАТЬ  Золото 1350" }); // тикнули только цифры
    const obs = await observeAfterAction({ settleMs: 0, clickPoint: POINT, before });
    expect(obs?.via).toBe("ocr");
    expect(obs?.changed).toBe(false);
    expect(obs?.weak).toBe(true);
    expect(obs?.text).toMatch(/изменились только ЧИСЛА/); // не «ничего не изменилось» — числа-то другие
  });

  it("экран изменился → наблюдение СИЛЬНОЕ (исход виден)", async () => {
    screenOcr.mockResolvedValue({ text: "ИГРАТЬ" });
    const before = await captureUiFingerprint(POINT);
    screenOcr.mockResolvedValue({ text: "ПОИСК ИГРЫ  ОТМЕНА" });
    const obs = await observeAfterAction({ settleMs: 0, clickPoint: POINT, before });
    expect(obs?.changed).toBe(true);
    expect(obs?.weak).not.toBe(true);
  });

  it("сравнивать не с чем (снимка «до» нет) → тоже СЛАБОЕ, а не «сверил»", async () => {
    screenOcr.mockResolvedValue({ text: "ИГРАТЬ  Золото 1200" });
    const obs = await observeAfterAction({ settleMs: 0, clickPoint: POINT });
    expect(obs?.weak).toBe(true);
    expect(obs?.text).toMatch(/исход НЕ подтверждён/);
  });

  it("цель по тексту (точка заранее неизвестна) → снимок «до» не снимаем", async () => {
    screenOcr.mockResolvedValue({ text: "что-то" });
    expect(await captureUiFingerprint()).toBeUndefined();
  });
});

/**
 * 🔴 Адверс-ревью правки (2026-09-02, MED): у сравнения было ДВА исхода, а состояний три —
 * и оба края врали. «Золото 600 → Золото 350» печаталось как «НИЧЕГО НЕ ИЗМЕНИЛОСЬ» (утверждение
 * факта, которого сенсор не устанавливал), а «Roshan 4:59 kill → Roshan 4:57 kiII» (тик таймера +
 * типовая ошибка распознавания l→I) давало changed:true, weak:false — то есть глифовый шум
 * засчитывался как СВЕРКА ИСХОДА.
 */
describe("compareOcr — три состояния и фильтр шума распознавания", () => {
  it("тексты равны → «same»", () => {
    expect(compareOcr("ИГРАТЬ Золото 600", "ИГРАТЬ Золото 600").kind).toBe("same");
  });

  it("различаются только числа → «digits» (может быть и таймер, и результат — не сверка)", () => {
    expect(compareOcr("Золото 600 Купить", "Золото 350 Купить").kind).toBe("digits");
    expect(compareOcr("Стр. 1 из 20", "Стр. 2 из 20").kind).toBe("digits");
  });

  it("глифовый шум OCR при тикающем таймере НЕ считается изменением", () => {
    expect(compareOcr("Roshan 4:59 kill", "Roshan 4:57 kiII").kind).toBe("digits");
    expect(nearSameWord("kill", "kiII")).toBe(true);
  });

  it("настоящая смена экрана → «changed» + что появилось/исчезло", () => {
    const c = compareOcr("ИГРАТЬ", "ПОИСК ИГРЫ ОТМЕНА");
    expect(c.kind).toBe("changed");
    expect(c.added.join(" ")).toMatch(/отмена/);
    expect(c.removed.join(" ")).toMatch(/играть/);
  });

  it("разные слова похожей длины изменением ОСТАЮТСЯ (фильтр не съедает смысл)", () => {
    expect(nearSameWord("играть", "отмена")).toBe(false);
    expect(compareOcr("Принять", "Отклонить").kind).toBe("changed");
  });
});

describe("наблюдение отражает три состояния", () => {
  it("шум распознавания на тикающем таймере не снимает verify-долг", async () => {
    screenOcr.mockResolvedValue({ text: "Roshan 4:59 kill" });
    const before = await captureUiFingerprint(POINT);
    screenOcr.mockResolvedValue({ text: "Roshan 4:57 kiII" });
    const obs = await observeAfterAction({ settleMs: 0, clickPoint: POINT, before });
    expect(obs?.changed).toBe(false);
    expect(obs?.weak).toBe(true); // до фикса: changed:true, weak:false → «сверил исход» на шуме
  });
});
