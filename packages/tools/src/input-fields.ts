/**
 * W2 (пакет 0, решение №9): allowlist полей по JSON-схеме инструмента.
 *
 * ActionCommand собирается НЕ как `{kind, ...input}`: всё, что модель прислала сверх схемы (`approval`, `commitApproved`,
 * `expectedForeground`, `space` и любые будущие служебные поля), в команду не попадает. Денилист служебных полей был бы
 * неполным по определению (закон CLAUDE.md «денилисты неполны»), поэтому источник правды — сама схема.
 *
 * Чистый модуль без импортов: сервер (command-fields) и тесты пакета.
 */

type Schema = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Ветки oneOf/anyOf схемы (или сама схема, если веток нет). */
function branches(schema: Schema): Schema[] {
  const alt = [schema.oneOf, schema.anyOf].find(Array.isArray) as unknown[] | undefined;
  return alt ? alt.filter(isObj) : [schema];
}

/** Объединение properties всех веток: имя поля → первая встреченная под-схема. */
function unionProps(schema: Schema): Map<string, Schema | undefined> {
  const out = new Map<string, Schema | undefined>();
  for (const b of branches(schema)) {
    const props = isObj(b.properties) ? b.properties : {};
    for (const [k, v] of Object.entries(props)) if (!out.has(k)) out.set(k, isObj(v) ? v : undefined);
  }
  return out;
}

/** Закрыта ли схема объекта: все объектные ветки с properties запрещают лишние поля. */
function closed(schema: Schema): boolean {
  const objs = branches(schema).filter((b) => isObj(b.properties));
  return objs.length > 0 && objs.every((b) => b.additionalProperties === false);
}

/** Поля верхнего уровня схемы (объединение веток). */
export function schemaFields(schema: unknown): ReadonlySet<string> {
  return isObj(schema) ? new Set(unionProps(schema).keys()) : new Set();
}

/**
 * Оставить в значении только то, что разрешает схема. Рекурсивно: закрытые объекты (additionalProperties:false) теряют
 * лишние ключи на любой глубине, массивы идут по `items`, свободные объекты (params) — как есть. Вход не мутируется.
 */
export function pickBySchema(schema: unknown, value: unknown): unknown {
  if (!isObj(schema)) return value;
  if (Array.isArray(value)) {
    const items = isObj(schema.items) ? schema.items : undefined;
    return items ? value.map((v) => pickBySchema(items, v)) : [...value];
  }
  if (!isObj(value)) return value;
  const props = unionProps(schema);
  const strict = closed(schema);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (props.has(k)) out[k] = pickBySchema(props.get(k), v);
    else if (!strict) out[k] = v;
  }
  return out;
}
