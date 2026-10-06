/**
 * Отбор сценариев под режим: фильтры пользователя, liveOnly, соответствие мозгу. Всё, что не запускаем, попадает в
 * `skipped` С ПРИЧИНОЙ — молчаливого исчезновения сценария из отчёта быть не должно.
 */
import type { EvalOptions, EvalScenario } from "./types.js";

export interface Selection {
  run: EvalScenario[];
  skipped: Array<{ id: string; reason: string }>;
}

type SelectOpts = Pick<EvalOptions, "brain" | "filter" | "tag" | "control">;

/** Причина пропуска или null, если сценарий этому режиму подходит. */
export function skipReason(s: EvalScenario, o: SelectOpts): string | null {
  if (s.liveOnly) return `liveOnly: ${s.liveOnly}`;
  if (s.brain === "scripted") return "нужен сценарный мозг: шва подмены LLM для WS-сервера лаборатории нет (startLabServer бросает на scripted)";
  if (o.brain === "off" && s.brain === "real" && !o.control) return "нужен настоящий мозг (запуск с --brain off); --control гонит такие сценарии как отрицательный контроль";
  return null;
}

export function selectScenarios(all: readonly EvalScenario[], o: SelectOpts): Selection {
  const seen = new Set<string>();
  for (const s of all) {
    if (seen.has(s.id)) throw new Error(`id сценария «${s.id}» повторяется — отчёт склеил бы разные сценарии`);
    seen.add(s.id);
  }
  const f = o.filter?.toLowerCase();
  const wanted = all.filter((s) => (!f || s.id.toLowerCase().includes(f) || s.title.toLowerCase().includes(f)) && (!o.tag || s.tags.includes(o.tag)));
  const sel: Selection = { run: [], skipped: [] };
  for (const s of wanted) {
    const why = skipReason(s, o);
    if (why) sel.skipped.push({ id: s.id, reason: why });
    else sel.run.push(s);
  }
  return sel;
}
