/**
 * W2 (пакет 0, решение №9): сборка ActionCommand по ALLOWLIST полей схемы инструмента.
 *
 * Было `{kind, ...input}` — всё, что прислала модель, уезжало клиенту: `approval`/`commitApproved` (самоодобрение §14),
 * `expectedForeground`, `space` и любые будущие служебные поля. Денилист таких полей неполон по определению, поэтому
 * источник правды — сама схема (`pickBySchema`: лишнее срезается на любой глубине закрытой схемы — в target, rect,
 * условии wait_for). Служебные поля (`origin`, `approval`) после этого ставит ТОЛЬКО сервер.
 *
 * Владелец после P0 — П3.
 */
import type { ActionKind } from "@jarvis/protocol";
import { TOOLS_BY_NAME, pickBySchema } from "@jarvis/tools";

/** Поля схемы, которые раскрывает сам сервер и клиенту не шлёт: серию act{steps} исполняет act-steps по шагу. */
const SERVER_ONLY_FIELDS: Readonly<Partial<Record<ActionKind, readonly string[]>>> = { "gui.act": ["steps"] };

/**
 * Команда из входа модели: только поля схемы `name`. Инструмента без схемы не бывает (тест пакета tools), но на
 * такой случай — fail-closed: одна команда без полей модели.
 */
export function commandFromInput(kind: ActionKind, name: string, input: Record<string, unknown>): Record<string, unknown> & { kind: ActionKind } {
  const schema = TOOLS_BY_NAME[name]?.input_schema;
  const picked = (schema ? pickBySchema(schema, input) : {}) as Record<string, unknown>;
  for (const f of SERVER_ONLY_FIELDS[kind] ?? []) delete picked[f];
  return { ...picked, kind };
}
