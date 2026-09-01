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
//  2) в строках trim + схлопывание пробельных прогонов — НО НЕ в контентных полях (см. CONTENT_KEYS);
//  3) выброс явно ВОЛАТИЛЬНЫХ полей по ИМЕНИ (nonce/idempotency_key/request_id/trace_id/
//     correlation_id) — поле, чья роль «быть каждый раз новым», не делает повтор «другим действием».
// Значения-таймстампы по СОДЕРЖИМОМУ НЕ трогаем: `fireAt` у set_reminder и подобные — семантика
// (три напоминания на разное время = три разных дела, а не топтание); ложный «повтор» здесь дал бы
// нудж, а после упорства — ложный честный ПРОВАЛ легитимной работы, что нарушает закон честности.
//
// 🔴 ДВА ОГРАНИЧЕНИЯ, поставленные адверс-ревью волны F (оба — ровно класс «ложный провал»):
//  • КОНТЕНТНЫЕ поля (content/text/code/old_string/…) НЕ нормализуются по пробелам: там whitespace —
//    СЕМАНТИКА (Python-отступы, YAML, Makefile-табы, переносы строк в печатаемом тексте). Схлопывание
//    делало «поправь отступы» тремя одинаковыми раундами → нудж «ты повторяешь ОДНО И ТО ЖЕ» (ложь) и
//    обрыв задачи честным провалом на легитимной итеративной работе.
//  • ВОЛАТИЛЬНЫЕ имена выбрасываются только там, где они действительно шум: у ВСТРОЕННЫХ инструментов
//    и только если после выброса от input что-то осталось. У `mcp__*` (внешние серверы, которые
//    владелец добавляет строкой в mcp.json) `request_id`/`trace_id` — часто СЕЛЕКТОР ЦЕЛИ: перебор
//    разных трейсов схлопывался в «повтор одного действия». Имя ключа не доказывает волатильность.
//
// Вход — tool input, УЖЕ прошедший JSON-парс ответа модели: циклов нет, глубина конечна.

const VOLATILE_KEY_RE = /^(nonce|idempotency[-_]?key|request[-_]?id|trace[-_]?id|correlation[-_]?id)$/i;

/**
 * Поля, где пробелы/переносы — СОДЕРЖИМОЕ, а не форматирование вызова: тело файла, код, печатаемый
 * текст, стороны find/replace. Для них строка берётся КАК ЕСТЬ (даже без trim: ведущий перевод строки
 * в теле файла — тоже содержимое).
 */
const CONTENT_KEY_RE = /^(content|text|code|body|script|sql|patch|diff|old|new|old_string|new_string|contents|data)$/i;

interface NormOpts {
  /** Выбрасывать волатильные поля (у mcp__* — нет: там это может быть селектор цели). */
  dropVolatile: boolean;
}

function normalizeValue(v: unknown, opts: NormOpts, key?: string): unknown {
  if (typeof v === "string") {
    // Контентное поле — без нормализации вовсе (whitespace = семантика).
    if (key && CONTENT_KEY_RE.test(key)) return v;
    return v.trim().replace(/\s+/g, " ");
  }
  if (Array.isArray(v)) return v.map((item) => normalizeValue(item, opts, key)); // порядок = семантика
  if (v && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let dropped = 0;
    for (const k of Object.keys(src).sort()) {
      if (opts.dropVolatile && VOLATILE_KEY_RE.test(k)) {
        dropped += 1;
        continue;
      }
      out[k] = normalizeValue(src[k], opts, k);
    }
    // Выброс опустошил объект → волатильное поле было ЕДИНСТВЕННЫМ содержательным, то есть на деле
    // селектором цели («прочитай трейс T1» → «…T2»). Возвращаем как есть: лучше не поймать повтор,
    // чем оборвать легитимный перебор ложным «ты повторяешь одно и то же».
    if (dropped > 0 && Object.keys(out).length === 0) {
      const raw: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) raw[k] = normalizeValue(src[k], { dropVolatile: false }, k);
      return raw;
    }
    return out;
  }
  return v; // number/boolean/null/undefined — как есть
}

/** Сигнатура раунда tool-вызовов для детектора повторов. Одинаковая → раунд повторяет прошлый. */
export function repeatSignature(toolUses: ReadonlyArray<{ name: string; input: unknown }>): string {
  return toolUses
    .map((t) => {
      // У внешних (MCP) инструментов схема неизвестна нам: «волатильное» имя там может быть ключом
      // сущности. Нормализуем только структуру/пробелы, ничего не выбрасывая.
      const opts: NormOpts = { dropVolatile: !t.name.startsWith("mcp__") };
      return `${t.name}:${JSON.stringify(normalizeValue(t.input, opts))}`;
    })
    .join("|");
}
