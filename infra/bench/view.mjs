// Стенд: человекочитаемый вывод CLI (tool/say/log/sites-log). Машинный — флаг --json.
import { saveImages } from "./client.mjs";

const cut = (s, n) => (String(s ?? "").length > n ? `${String(s).slice(0, n)}… [+${String(s).length - n}]` : String(s ?? ""));

export function questionsView(qs = []) {
  return qs.map((q) => `  §14 #${q.n} [${q.kind}] → ${q.answer} (${q.outcome})${q.overflow ? " OVERFLOW" : ""}: ${cut(q.summary.replace(/\n/g, " "), 200)}`).join("\n");
}

export function toolView(r, { full = false } = {}) {
  const res = r.result ?? {};
  const imgs = saveImages(res, "tool");
  const flags = Object.entries(res.flags ?? {}).map(([k, v]) => `${k}=${v}`).join(" ");
  return [
    `${res.isError ? "ОШИБКА" : "ok"} за ${r.ms} мс${flags ? ` · ${flags}` : ""} · §14 вопросов: ${r.questions?.length ?? 0}${r.policyOverflow ? " (политика кончилась!)" : ""}`,
    r.questions?.length ? questionsView(r.questions) : "",
    Object.keys(r.resolved ?? {}).length ? `  подстановки: ${JSON.stringify(r.resolved)}` : "",
    r.clientActions?.length ? `  клиенту ПК (отказано): ${r.clientActions.map((a) => a.kind).join(", ")}` : "",
    imgs.length ? `  картинки: ${imgs.join(", ")}` : "",
    "---",
    full ? res.text : cut(res.text, 1500),
  ]
    .filter(Boolean)
    .join("\n");
}

export function sayView(r) {
  const rounds = (r.rounds ?? []).map((x) => {
    const uses = (x.reply?.toolUses ?? []).map((u) => `${u.name}(${cut(JSON.stringify(u.input), 120)})`).join(", ");
    const res = (x.toolResults ?? []).map((t) => `${t.isError ? "✗" : "✓"} ${cut(t.text.replace(/\s+/g, " "), 100)}`).join(" | ");
    const nudge = x.i > 0 && x.userText ? ` НУДЖ: ${cut(x.userText.replace(/\s+/g, " "), 100)}` : "";
    return `  #${x.i}${res ? ` ← ${res}` : ""}${nudge}\n     → ${x.reply ? uses || `текст: ${cut(x.reply.text, 120)}` : "СТАБ (сценарий кончился)"}${x.unresolved?.length ? ` НЕРАЗРЕШЕНО: ${x.unresolved.join(",")}` : ""}`;
  });
  const t = r.task;
  return [
    `финал: ${r.final ?? "(нет реплики)"}${r.timedOut ? " · ТАЙМАУТ" : ""} · ${r.ms} мс`,
    `модель: ходов петли ${r.llm?.loopCalls}/${r.llm?.scriptTurns} сценария, побочных ${r.llm?.sideCalls}${r.llm?.exhausted ? `, СЦЕНАРИЙ КОНЧИЛСЯ (+${r.llm.extraLoopCalls})` : ""}${r.llm?.loopCalls === 0 ? " — реплику закрыл tier0/кэш без модели!" : ""}`,
    t ? `задача: ${t.state} «${t.title}» шагов ${t.stepsDone}${t.lastError ? ` · ошибка: ${t.lastError}` : ""}${t.irreversibleDone?.length ? ` · необратимое: ${t.irreversibleDone.join("; ")}` : ""}` : "задачи нет",
    r.questions?.length ? `§14 вопросов: ${r.questions.length}\n${questionsView(r.questions)}` : "§14 вопросов: 0",
    r.stray?.length ? `вопросы-сироты: ${r.stray.length}` : "",
    "раунды:",
    ...rounds,
  ]
    .filter(Boolean)
    .join("\n");
}

export function logLine(line) {
  try {
    const e = JSON.parse(line);
    const meta = e.meta === undefined ? "" : ` ${cut(typeof e.meta === "string" ? e.meta : JSON.stringify(e.meta), 400)}`;
    return `${String(e.ts).slice(11, 23)} ${String(e.level).toUpperCase().padEnd(5)} (${e.scope}) ${e.msg}${meta}`;
  } catch {
    return line;
  }
}

export function eventLine(e) {
  return `${new Date(e.ts).toISOString().slice(11, 23)} ${e.kind === "fact" ? "ФАКТ " : "trace"} ${e.site.padEnd(9)} ${e.type.padEnd(16)} run=${e.run || "-"} ${cut(JSON.stringify(e.data), 200)}`;
}
