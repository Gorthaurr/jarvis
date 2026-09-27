/**
 * C3 (аудит прод-логов 27.09): 403 «Request not allowed» при входе в Windows (VPN ещё не поднялся) назывался
 * «ключ доступа не принят» и выключал API-канал на 6 часов терминальным латчем, хотя ключ исправен (позже на
 * нём же приходил 400 credits). Неверно названная причина — та же неправда, что ложное «Готово»: владелец
 * пошёл бы чинить ключ вместо VPN. Тексты — в форме настоящего SDK: `${status} ${JSON.stringify(body)}`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { _resetApiFailureForTest, _setApiFailureForTest, classifyApiError, llmFailureLine } from "./anthropic.js";

const REGION_403 ='403 {"type":"error","error":{"type":"forbidden","message":"Request not allowed"}}';
const KEY_403 = '403 {"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use the specified resource."}}';
const KEY_401 = '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
const CREDITS = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API"}}';

afterEach(() => _resetApiFailureForTest());

describe("classifyApiError — 403 гео-блока не выдаётся за плохой ключ (C3)", () => {
  it("403 forbidden «Request not allowed» → сетевой/региональный класс с советом про VPN, НЕ auth", () => {
    const f = classifyApiError(REGION_403, 403);
    expect(f.kind).not.toBe("auth"); // до фикса: auth → латч на 6 ч и «поправить ключ»
    expect(f.kind).toBe("region");
    expect(f.human).toMatch(/VPN/);
    expect(f.human).not.toMatch(/ключ/);
  });

  it("тот же текст без числового status (ошибка без поля status) — тот же класс", () => {
    expect(classifyApiError(REGION_403).kind).toBe("region");
  });

  it("фраза владельцу о последнем отказе называет VPN, а не ключ", () => {
    _setApiFailureForTest(REGION_403, 403);
    expect(llmFailureLine()).toMatch(/VPN/);
    expect(llmFailureLine()).not.toMatch(/ключ/);
  });

  it("403 с признаками КЛЮЧА (permission_error / API key) остаётся auth — гео-правило не шире нужного", () => {
    expect(classifyApiError(KEY_403, 403).kind).toBe("auth");
    expect(classifyApiError(KEY_401, 401).kind).toBe("auth");
  });

  it("кончившийся баланс по-прежнему credits", () => {
    expect(classifyApiError(CREDITS, 400).kind).toBe("credits");
  });

  // Адверс-ревью р1 (C3): CLI без терминала оборачивает ЛЮБОЙ 401/403 в «Failed to authenticate. API Error: …» —
  // слово authenticate в обёртке не признак ключа. Зеркало правила подписки: та же строка → region.
  it("обёртка CLI «Failed to authenticate. API Error: 403 …» → region; двоеточие и OAuth остаются auth", () => {
    expect(classifyApiError("Failed to authenticate. API Error: 403 Request not allowed", 403).kind).toBe("region");
    expect(classifyApiError(`Failed to authenticate. API Error: ${REGION_403}`, 403).kind).toBe("region");
    expect(classifyApiError("Failed to authenticate: forbidden", 403).kind).toBe("auth");
    expect(classifyApiError("Failed to authenticate. API Error: 403 Forbidden: OAuth token revoked", 403).kind).toBe("auth");
  });
});
