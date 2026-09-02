/**
 * ГАРД УЧЁТНЫХ ДАННЫХ (§0 принцип 5) — чистая логика решения.
 *
 * Здесь проверяется ТО, ЧЕМ гард судит: связка «признак поля + значение». Проводку (что гард реально
 * стоит на каждом печатающем инструменте) держит `dispatch-credentials.test.ts` — по правилу проекта
 * гард проверяется ПОВЕДЕНИЕМ петли/диспетчера, а не наличием строк в исходнике.
 *
 * Половина кейсов здесь — про ЛОЖНЫЕ СРАБАТЫВАНИЯ: владелец кодит и диктует тексты, и сломанная
 * легитимная печать — такой же дефект, как пропущенный пароль.
 */
import { describe, expect, it } from "vitest";
import { carriesCardNumber, checkCredentialInput, collectTypedFields } from "./credential-guard.js";

describe("признак поля → блок ввода", () => {
  it("browser_act type в input[type=password] → отказ с честной формулировкой", () => {
    const v = checkCredentialInput("browser_act", { intent: "type", params: { selector: 'input[type="password"]', text: "hunter2" } });
    expect(v.block).toBeTruthy();
    expect(v.block).toMatch(/не ввожу, введите сами/i);
  });

  it("ui_invoke setValue в поле с именем «Пароль» → отказ", () => {
    const v = checkCredentialInput("ui_invoke", { pattern: "setValue", value: "qwerty", target: { by: "role", role: "Edit", name: "Пароль" } });
    expect(v.block).toMatch(/пароль или код подтверждения/i);
  });

  it("web_act type в поле кода из СМС → отказ", () => {
    const v = checkCredentialInput("web_act", { intent: "type", params: { selector: "#sms-code", text: "481502" } });
    expect(v.block).toBeTruthy();
  });

  it("поле одноразового кода по лейблу («Код подтверждения») → отказ", () => {
    const v = checkCredentialInput("browser_act", { intent: "type", params: { label: "Код подтверждения", text: "481502" } });
    expect(v.block).toBeTruthy();
  });

  it("поле CVV → отказ как по платёжным реквизитам (§0), даже если значение Луна не проходит", () => {
    const v = checkCredentialInput("browser_act", { intent: "type", params: { selector: "#cvv", text: "123" } });
    expect(v.block).toMatch(/платёжные реквизиты/i);
  });

  it("berст browser_batch: подпись поля берётся по ref из последнего снимка", () => {
    const hints: Record<string, string> = { e3_0: "Логин #login input", e3_1: "Пароль #pass input" };
    const steps = [
      { ref: "e3_0", intent: "type", params: { text: "anton" } },
      { ref: "e3_1", intent: "type", params: { text: "s3cret" } },
    ];
    const v = checkCredentialInput("browser_batch", { steps }, (r) => hints[r]);
    expect(v.block).toBeTruthy();
    // Без резолвера ref немой — гард честно НЕ знает, что за поле, и берст не ломает.
    expect(checkCredentialInput("browser_batch", { steps }).block).toBeUndefined();
  });

  it("input_batch: шаг input.type / ui.invoke setValue в поле пароля тоже под гардом", () => {
    const byInvoke = checkCredentialInput("input_batch", {
      steps: [{ action: "ui.invoke", target: { by: "role", role: "Edit", name: "Password" }, params: { pattern: "setValue", value: "x" } }],
    });
    expect(byInvoke.block).toBeTruthy();
  });
});

describe("номер карты в значении → блок (переиспользуем проверку заказа, Луна)", () => {
  it("карта с разделителями ловится на любом пути ввода", () => {
    expect(checkCredentialInput("input_type", { text: "4111 1111 1111 1111" }).block).toBeTruthy();
    expect(checkCredentialInput("system_clipboard", { op: "write", text: "4111-1111-1111-1111" }).block).toBeTruthy();
  });

  it("carriesCardNumber = та же семантика, что у order_place", () => {
    expect(carriesCardNumber("оплата 4111111111111111")).toBe(true);
    expect(carriesCardNumber("штрихкод 4006381333931")).toBe(false); // не проходит Луна → не карта
  });
});

describe("🔴 ложные срабатывания: легитимная печать НЕ ломается", () => {
  it("обычный текст с числами (код, суммы, годы, телефон) проходит без блока и без предупреждения", () => {
    const texts = [
      "const timeout = 120000; // 2026 год, версия 1.2.3",
      "Перевёл 15000 рублей за январь 2026",
      "мой телефон +7 999 123-45-67",
      "заказ №1234567890123 приедет завтра",
    ];
    for (const text of texts) {
      const v = checkCredentialInput("input_type", { text });
      expect(v.block, text).toBeUndefined();
      expect(v.note, text).toBeUndefined();
    }
  });

  it("🔴 цифры РАЗНЫХ слов не склеиваются в «карту» (найдено этим же тестом до фикса)", () => {
    // order-guard считает разделителем любой не-латинский символ → в русской прозе кириллица
    // стиралась, «120000» + «2026» + «123» превращались в 13-значный номер, проходивший Луна,
    // и Джарвис отказывался печатать код владельца. Кандидат теперь вырезается по разделителям.
    expect(carriesCardNumber("const timeout = 120000; // 2026 год, версия 1.2.3")).toBe(false);
    expect(carriesCardNumber("итог 4111 рублей, счёт 1111 за 1111 месяц, дом 1111")).toBe(false);
  });

  it("25-значный идентификатор не считается картой (паритет с order_place)", () => {
    expect(carriesCardNumber("id 4111111111111111411111111")).toBe(false);
  });

  it("Bootstrap-селектор .card-body и слово passport полем секрета не считаются", () => {
    expect(checkCredentialInput("browser_act", { intent: "type", params: { selector: ".card-body input.form-control", text: "Москва" } }).block).toBeUndefined();
    expect(checkCredentialInput("browser_act", { intent: "type", params: { label: "Номер паспорта", text: "4509 123456" } }).block).toBeUndefined();
    expect(checkCredentialInput("browser_act", { intent: "type", params: { placeholder: "Passenger name", text: "Anton" } }).block).toBeUndefined();
  });

  it("не-печатающие интенты и op=read гард не трогает вовсе", () => {
    expect(collectTypedFields("browser_act", { intent: "click", params: { text: "Пароль забыли?" } })).toHaveLength(0);
    expect(collectTypedFields("system_clipboard", { op: "read" })).toHaveLength(0);
    expect(collectTypedFields("ui_invoke", { pattern: "invoke", target: { by: "role", role: "button", name: "Пароль" } })).toHaveLength(0);
  });

  it("известное поле, НЕ похожее на секрет: короткое число печатается молча (без нотаций)", () => {
    const v = checkCredentialInput("browser_act", { intent: "type", params: { selector: "#search", text: "2026" } });
    expect(v.block).toBeUndefined();
    expect(v.note).toBeUndefined();
  });
});

describe("признака поля нет → предупреждаем, но не блокируем", () => {
  it("input_type голого 6-значного кода: работа идёт, модель получает напоминание", () => {
    const v = checkCredentialInput("input_type", { text: "481502" });
    expect(v.block).toBeUndefined();
    expect(v.note).toMatch(/не ввожу, введите сами/i);
  });

  it("ui_invoke по handle (имя элемента неизвестно) — тоже предупреждение, а не отказ", () => {
    const v = checkCredentialInput("ui_invoke", { pattern: "setValue", value: "123456", target: { by: "handle", handle: "0x1f" } });
    expect(v.block).toBeUndefined();
    expect(v.note).toBeTruthy();
  });
});
