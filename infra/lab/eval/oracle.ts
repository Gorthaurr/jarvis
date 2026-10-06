/**
 * Прогон ЭТАЛОНА сценария без мозга: вызовы толкового агента идут через настоящий серверный `dispatchTool` над FakeDesktop
 * (tools/harness — гейты §0/§14, честные исходы), а итог собирается в тот же `EvalContext`, что видит check() при живом
 * прогоне. Так проверки испытываются на «цель достигнута» (зелёный), «ничего не сделано» (красный) и на чужом, неверном
 * поведении соседа (красный) — без подписки и без сервера.
 */
import { applyServices } from "./run-parts.js";
import { mkTurn, stubServer } from "./testkit.js";
import { createToolLab } from "../tools/harness.js";
import type { ToolContext } from "../../../apps/server/src/brain/tools/dispatch.js";
import type { CheckResult } from "../lib/contracts.js";
import type { EvalContext, EvalScenario, OracleTurn } from "./types.js";

/** Пустой эталон под число ходов сценария: агент ничего не сделал и промолчал. */
export const noopOracle = (s: EvalScenario): OracleTurn[] => Array.from({ length: 1 + (s.steps?.length ?? 0) }, () => ({ calls: [], answer: "" }));

/** Эталон, у которого ответ заменён на бодрый рапорт: «Готово, сэр» без единого действия (ложный успех). */
export const braggingOracle = (s: EvalScenario, claim = "Готово, сэр, всё сделано."): OracleTurn[] => noopOracle(s).map((t) => ({ ...t, answer: claim }));

/** Стора навыков в harness нет: эталону хватает записи в памяти (проверяется формула check(), а не skill-стор сервера). */
const skillsStub = (): ToolContext["skills"] =>
  ({ list: async () => [], get: async () => null, recall: async () => null, save: async (_u: string, i: { name: string }) => ({ id: `sk-${i.name}`, name: i.name, version: 1 }) }) as unknown as ToolContext["skills"];

/**
 * Прогнать эталон и СРАЗУ вынести вердикт check(): каталог данных лаборатории (reminders.json и т.п.) живёт, пока жива лаба,
 * а проверки читают его через `ctx.server.dataDir`.
 */
export async function judgeOracle(s: EvalScenario, script: OracleTurn[]): Promise<{ ctx: EvalContext; result: CheckResult; errored: string[] }> {
  const restore = applyServices(s.services);
  const lab = createToolLab({ ...(s.seed ? { seed: s.seed } : {}), ...(s.confirm !== undefined ? { confirm: s.confirm } : {}), ctx: { skills: skillsStub() } });
  try {
    const before = lab.desktop.snapshot();
    const turns = [];
    const marks = [];
    const errored: string[] = [];
    for (const ot of script) {
      const t = mkTurn({ answer: ot.answer, tasks: ot.tasks ?? [], chat: ot.answer ? [{ role: "assistant", text: ot.answer, at: 0 }] : [] });
      for (const c of ot.calls) {
        const out = await lab.call(c.tool, c.args, c.confirm !== undefined ? { confirm: c.confirm } : {});
        if (out.notVerifiable) throw new Error(`эталон «${s.id}»: ${c.tool} не проверяется в лаборатории (${out.notVerifiable})`);
        if (out.isError && !c.allowError) errored.push(`${c.tool}: ${out.text.slice(0, 160)}`);
        t.actions.push(...out.actions);
        t.confirms.push(...out.asked.map((q) => ({ summary: q.summary, kind: q.kind, answer: q.answer })));
      }
      turns.push(t);
      marks.push(lab.desktop.snapshot());
    }
    const ctx: EvalContext = { desktop: lab.desktop.snapshot(), before, turns, turn: turns[turns.length - 1]!, marks, userId: lab.userId, server: stubServer({ dataDir: lab.dataDir }) };
    return { ctx, result: await s.check(ctx), errored };
  } finally {
    await lab.close();
    restore();
  }
}
