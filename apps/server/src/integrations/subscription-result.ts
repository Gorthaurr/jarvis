/**
 * Исход хода SDK подписки — по РЕАЛЬНОЙ форме сообщений Claude Agent SDK (sdk.d.ts 0.3.251), не по догадкам.
 *
 * Прод 25–27.09 (C2): на входе в Windows API отвечал 403, CLI прислал текст ошибки ассистентом и
 * result{subtype:"success", is_error:true} — ход считался выполненным. Провал судим по subtype, is_error и
 * api_error_status. Но (адверс-ревью р1): обрыв ПОСЛЕ готового ответа («Connection lost mid-response») даёт тот же
 * is_error:true и кадр-ошибку `SDKAssistantMessage.error` в хвосте — его текст в ответ не кладём, иначе эхо ошибки
 * выбросило бы настоящую работу модели (ложный провал — закон 1 наизнанку). error_max_turns — провал, как у SDK
 * (is_error:true): ход с вызовом инструмента сохраняет потребитель (toolUses → не стаб), с текстом — «частичный
 * ответ», а ПУСТОЙ ход на пределе ходов — честный провал, не пустой успех. Текст ошибки у SDKResultError — в errors[].
 */

/** Кадр ассистента — синтетическая ошибка API (`error: 'server_error' | 'max_output_tokens' | …`), не ответ модели. */
export function isApiErrorFrame(msg: Record<string, unknown>): boolean {
  return msg.error != null;
}

/** Разбор `result`: провал, текст ошибки (для классификации причины) и финальный текст успеха. */
export function resultOutcome(msg: Record<string, unknown>): { errorText?: string; resultText?: string } {
  const sub = typeof msg.subtype === "string" ? msg.subtype : "";
  const failed = (sub !== "" && sub !== "success") || msg.is_error === true || msg.api_error_status != null;
  if (!failed) return sub === "success" && typeof msg.result === "string" ? { resultText: msg.result } : {};
  // Первый НЕПУСТОЙ кандидат (пустая строка = ложный успех у потребителя), служебная диагностика CLI — последней.
  const errors = Array.isArray(msg.errors) ? msg.errors.map((e) => String(e ?? "")) : [];
  const reasons = [String(msg.result ?? ""), ...errors.filter((e) => !e.startsWith("[ede_diagnostic]")), ...errors];
  return { errorText: reasons.find((e) => e.trim() !== "") ?? (sub || "ошибка API") };
}
