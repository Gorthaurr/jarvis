// Нормализованный ключ повтора для anti-runaway (§20; волна F «адаптация OpenClaw» F1, 2026-08-31).
//
// Было: сырой `${name}:${JSON.stringify(input)}` — «байт-в-байт». Модель, повторяющая ТО ЖЕ действие,
// но с переставленными ключами JSON, лишним пробелом в строке или свежим nonce/request-id в аргументах,
// каждый раунд получала «новую» сигнатуру → серия сбрасывалась, детектор молчал, и петля флудила до
// family-капа (6/12 раундов вместо 3/4). Идея из loop-detection OpenClaw 2.0: хеш повторов считается
// по НОРМАЛИЗОВАННЫМ аргументам («delivery IDs alone do not make repeated equivalent sends look like
// progress»).
//
// Нормализация СОЗНАТЕЛЬНО узкая — только то, что не меняет СМЫСЛ действия:
//  1) стабильный порядок ключей объектов (перестановка полей = то же действие);
//  2) в строках trim + схлопывание пробельных прогонов (косметика, не семантика);
//  3) выброс явно ВОЛАТИЛЬНЫХ полей по ИМЕНИ (nonce/idempotency_key/request_id/trace_id/
//     correlation_id) — поле, чья роль «быть каждый раз новым», не делает повтор «другим действием».
// Значения-таймстампы по СОДЕРЖИМОМУ НЕ трогаем: `fireAt` у set_reminder и подобные — семантика
// (три напоминания на разное время = три разных дела, а не топтание); ложный «повтор» здесь дал бы
// нудж, а после упорства — ложный честный ПРОВАЛ легитимной работы, что нарушает закон честности.
// Ложный срабатывание нормализаций 1-3 безопасно по построению: если вызовы отличаются ТОЛЬКО
// порядком ключей/пробелами/nonce — это и есть то же действие, нудж «сверь глазами» уместен.
//
// Вход — tool input, УЖЕ прошедший JSON-парс ответа модели: циклов нет, глубина конечна.

const VOLATILE_KEY_RE = /^(nonce|idempotency[-_]?key|request[-_]?id|trace[-_]?id|correlation[-_]?id)$/i;

function normalizeValue(v: unknown): unknown {
  if (typeof v === "string") return v.trim().replace(/\s+/g, " ");
  if (Array.isArray(v)) return v.map(normalizeValue); // порядок элементов — семантика, не трогаем
  if (v && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (VOLATILE_KEY_RE.test(k)) continue;
      out[k] = normalizeValue(src[k]);
    }
    return out;
  }
  return v; // number/boolean/null/undefined — как есть
}

/** Сигнатура раунда tool-вызовов для детектора повторов. Одинаковая → раунд повторяет прошлый. */
export function repeatSignature(toolUses: ReadonlyArray<{ name: string; input: unknown }>): string {
  return toolUses.map((t) => `${t.name}:${JSON.stringify(normalizeValue(t.input))}`).join("|");
}
