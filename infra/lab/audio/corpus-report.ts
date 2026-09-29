/**
 * Запуск корпуса и markdown-отчёт. Цифры — измерение на 4 TTS-голосах (Yandex) и их искажениях, НЕ на голосе владельца в
 * его комнате: живой промах ≈50% (CHANGELOG) этим не воспроизвести и не опровергнуть. Отчёт говорит это сам.
 */
import { CONDITIONS, type CorpusReport, buildCorpus, runCorpus, summarize } from "./corpus.js";
import { loadHearing } from "./hearing-rig.js";

const pct = (a: number, b: number): string => (b === 0 ? "—" : `${a}/${b} (${Math.round((100 * a) / b)}%)`);

export async function runCorpusReport(opts: { quick?: boolean; dir?: string; hearingDir?: string } = {}): Promise<{ ok: true; report: CorpusReport; markdown: string } | { ok: false; reason: string }> {
  const load = await loadHearing(opts.hearingDir);
  if (!load.ok) return { ok: false, reason: load.reason };
  const items = buildCorpus({ ...(opts.dir ? { dir: opts.dir } : {}), ...(opts.quick ? { quick: true } : {}) });
  const report = summarize(await runCorpus(load, items, CONDITIONS));
  return { ok: true, report, markdown: formatReport(report, items.length) };
}

export function formatReport(r: CorpusReport, items: number): string {
  const L: string[] = ["# Отчёт слуха по корпусу (KWS «Джарвис» + подстраховка клиента)", ""];
  L.push(`Образцов: ${items}, условий тракта: ${r.byCondition.length}. Слух настоящий (sherpa KWS + Silero + AudioCoordinator), сервер не участвует.`, "");
  L.push("| условие | KWS попал (ожидалось «Джарвис») | ложные (ожидалась тишина) | промахи, дошедшие до подстраховки клиента | «спорные» срезы: сработал |", "|---|---|---|---|---|");
  for (const c of r.byCondition) L.push(`| ${c.cond} | ${pct(c.posHits, c.posN)} | ${pct(c.falsePositives, c.negN)} | ${pct(c.rescuable, c.misses)} | ${pct(c.eitherHits, c.eitherN)} |`);
  L.push("", "## По вариантам (доля срабатываний KWS)", "");
  const conds = r.byCondition.map((c) => c.cond);
  L.push(`| вариант | ожидание | ${conds.join(" | ")} |`, `|---|---|${conds.map(() => "---").join("|")}|`);
  const groups = [...new Map(r.cells.map((c) => [c.item.group, c.item.expect])).entries()];
  for (const [g, exp] of groups) {
    const row = conds.map((cond) => {
      const cs = r.cells.filter((c) => c.cond === cond && c.item.group === g);
      return pct(cs.filter((c) => c.hit).length, cs.length);
    });
    L.push(`| ${g} | ${exp === "hit" ? "срабатывает" : exp === "none" ? "тишина" : "не определено"} | ${row.join(" | ")} |`);
  }
  const fp = r.cells.filter((c) => c.item.expect === "none" && c.hit);
  const cleanMiss = r.cells.filter((c) => c.item.group === "оригинал" && c.item.expect === "hit" && !c.hit);
  L.push("", "## Ложные срабатывания", "", ...(fp.length ? fp.map((c) => `- ${c.item.id} @ ${c.cond}`) : ["нет"]));
  L.push("", "## Промахи на чистых оригиналах", "", ...(cleanMiss.length ? cleanMiss.map((c) => `- ${c.item.id} @ ${c.cond}: подстраховка клиента ${c.rescue ? "получила отрезок" : "НЕ получила отрезок"}`) : ["нет"]));
  L.push(
    "",
    "## Как читать (границы измерения)",
    "",
    "- Голоса — четыре TTS (filipp/alena/zahar/jane), не голос владельца; комната и микрофон — синтетика. Живой промах ≈50% отсюда не воспроизводится и не опровергается.",
    "- Корпус нормализован (пик 0,6–0,7), живой мик даёт 0,01–0,04: `tanh(6x)` насыщает громкие образцы — поэтому уровень варьируется, а не даётся одной цифрой.",
    "- «Дошло до подстраховки» = клиент отправил отрезок на проверку (0,45–4 с, пик rms ≥ 6000, сервер в покое). Решение принимает облачный STT сервера — здесь не измерено. Тихий мик (×0.05) до подстраховки не доходит по построению (порог пика).",
    "- Near-miss получены СРЕЗАМИ (нельзя синтезировать новые слова без TTS-ключа) плюс настоящими neg_* («джаз/джип/Джордж/Джессика»).",
    "",
  );
  return L.join("\n");
}
