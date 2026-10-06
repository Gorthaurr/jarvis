/**
 * skill.execute FakeDesktop: НАСТОЯЩИЙ клиентский runSkill (skill-runner/index.ts — отмена, бюджет, ретраи, expect с auto-wait,
 * предусловие, запрет ретрая коммита, actionInjected) над лабораторным SkillActuator: каждый шаг = команда в `dispatch`
 * (то есть в те же обработчики GUI/системы, что и обычные команды), время — виртуальное (core.advance), §14 — service-skill-gate.
 * Так «серия шагов, стоп на первой ошибке, stepIndex, stepActionInjected, needsApproval» — код клиента, а не его копия.
 */
import { REPLAY_TYPE_MAX_CHARS } from "@jarvis/protocol";
import type { ActionCommand, ActionResult, CommitApproval, SkillStep } from "@jarvis/protocol";
import { ActionError } from "../../../apps/client/main/actuators/action-error.js";
import { assertLaunchAllowed } from "../../../apps/client/main/actuators/bridge-uri.js";
import { outcomeToActionResult, runSkill } from "../../../apps/client/main/skill-runner/index.js";
import type { SkillActuator } from "../../../apps/client/main/skill-runner/index.js";
import type { DesktopCore, KindHandler, KindHandlers } from "./core.js";
import { type StepGate, createStepGate } from "./service-skill-gate.js";
import type { ServiceOptions } from "./service-options.js";
import { str } from "./service-state.js";

type SkillCmd = Extract<ActionCommand, { kind: "skill.execute" }>;
const STEP_COST_MS = 100;

/** Шаг навыка → команда клиенту (поля — из params/target, как в client-actuator.ts); undefined — шаг без действия. */
function commandOf(step: SkillStep): ActionCommand | undefined | "unknown" {
  const p = step.params ?? {};
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  switch (step.action) {
    case "app.launch":
      return { kind: "app.launch", app: str(p.app) };
    case "app.focus":
      return { kind: "app.focus", app: str(p.app) };
    case "browser.open":
      return { kind: "browser.open", url: str(p.url) };
    case "ui.invoke":
      if (!step.target) throw new Error("ui.invoke без target");
      return { kind: "ui.invoke", target: step.target, pattern: (p.pattern as "invoke") ?? "invoke", ...(str(p.value) ? { value: str(p.value) } : {}) };
    case "ui.ground":
      return step.target?.by === "role" ? { kind: "ui.ground", query: { role: step.target.role, ...(step.target.name ? { name: step.target.name } : {}) } } : undefined;
    case "input.type": {
      const text = str(p.text);
      if (text.length > REPLAY_TYPE_MAX_CHARS) throw new Error(`input.type: текст ${text.length} символов не влезает в бюджет реплея (кап ${REPLAY_TYPE_MAX_CHARS}) — длинный ввод не через навык`);
      return { kind: "input.type", text };
    }
    case "input.key":
      return { kind: "input.key", combo: str(p.combo), ...(p.mode === "down" || p.mode === "up" ? { mode: p.mode } : {}), ...(p.scancode === true ? { scancode: true } : {}) };
    case "input.click":
      if (!step.target) throw new Error("input.click без target");
      return { kind: "input.click", target: step.target, method: p.method === "physical" ? "physical" : "silent", ...(p.button === "right" || p.button === "middle" ? { button: p.button } : {}), ...(num(p.count) !== undefined ? { count: num(p.count) } : {}) };
    case "input.mouse": {
      const op = str(p.op);
      if (op !== "move" && op !== "down" && op !== "up" && op !== "wheel" && op !== "drag") throw new Error(`input.mouse: неизвестный op «${op}»`);
      return { kind: "input.mouse", op, x: num(p.x), y: num(p.y), toX: num(p.toX), toY: num(p.toY), dx: num(p.dx), dy: num(p.dy), ...(p.button === "right" || p.button === "middle" ? { button: p.button } : {}), ...(p.space === "screen" ? { space: "screen" as const } : {}), ...(typeof p.frame === "string" ? { frame: p.frame } : {}) };
    }
    case "wait":
    case "ground":
    case "verify":
      return undefined;
    default:
      return "unknown";
  }
}

function labActuator(core: DesktopCore, dispatch: KindHandler, parent: SkillCmd, gate: StepGate, meta: { commandId: string; timeoutMs: number }): SkillActuator {
  let n = 0;
  /** Вложенная команда: происхождение хода наследуем, одобрение — только то, что рубеж списал под ЭТОТ шаг. */
  const send = async (cmd: ActionCommand, approval?: CommitApproval): Promise<ActionResult> =>
    dispatch({ ...cmd, ...(parent.origin ? { origin: parent.origin } : {}), ...(parent.proactive ? { proactive: true } : {}), ...(approval ? { approval } : {}) } as ActionCommand, { commandId: `${meta.commandId}#${++n}`, timeoutMs: meta.timeoutMs });
  const must = async (cmd: ActionCommand, approval?: CommitApproval): Promise<ActionResult> => {
    const r = await send(cmd, approval);
    if (!r.ok) throw new ActionError(r.error?.message ?? "шаг не выполнен", { code: r.error?.code ?? "runtime", data: r.data, injected: r.stepActionInjected === true });
    return r;
  };

  return {
    async executeStep(step) {
      core.advance(STEP_COST_MS);
      const p = step.params ?? {};
      if (step.action === "app.launch" || step.action === "browser.open") assertLaunchAllowed(step.action === "app.launch" ? p.app : p.url, step.action);
      if (step.action === "wait") return void core.advance(Math.min(15_000, Math.max(0, Number(p.ms) || 0)));
      const cmd = commandOf(step);
      if (cmd === "unknown") throw new Error(`неизвестное действие шага «${step.action}» (настоящий клиент такой шаг молча пропускает — лаборатория это не скрывает)`);
      if (!cmd) return;
      const approval = gate(step);
      const r = await must(cmd, approval);
      if (step.action === "app.focus" && (r.data as { focused?: boolean } | undefined)?.focused === false) throw new Error(`окно «${str(p.app)}» не сфокусировано (фокус не перешёл)`);
    },
    async checkExpect(expect) {
      if (expect.kind === "visual") {
        const needle = (expect.text ?? "").trim().toLowerCase();
        if (!needle) return false;
        const r = await send({ kind: "screen.ocr" });
        return r.ok && String((r.data as { text?: string } | undefined)?.text ?? "").toLowerCase().includes(needle);
      }
      if (!expect.role) return true;
      return (await send({ kind: "ui.ground", query: { role: expect.role, ...(expect.name ? { name: expect.name } : {}) } })).ok;
    },
    async checkPrecondition(pre) {
      return (await send({ kind: "ui.ground", query: { role: pre.role, ...(pre.name ? { name: pre.name } : {}), ...(pre.nameMode ? { nameMode: pre.nameMode } : {}) } })).ok;
    },
  };
}

export function skillHandlers(core: DesktopCore, dispatch: KindHandler, opts: () => ServiceOptions): KindHandlers {
  return {
    "skill.execute": async (cmd, meta) => {
      const c = cmd as SkillCmd;
      const t0 = core.now();
      const outcome = await runSkill({
        skillId: c.skillId,
        version: c.version,
        steps: c.steps,
        params: c.params,
        cancel: { cancelled: false },
        deadlineMs: opts().skillBudgetMs,
        actuator: labActuator(core, dispatch, c, createStepGate(core, c.approval), meta),
        sleep: async (ms) => core.advance(ms),
        now: () => core.now(),
        overlayBlockReason: () => null, // режима выделения (вуали) в лаборатории нет
        veiledSince: () => false,
      });
      core.effect("skill.execute", { skillId: c.skillId, version: c.version, steps: c.steps.length, ok: outcome.ok, ...(outcome.ok ? {} : { failedStepIndex: outcome.failedStepIndex, message: outcome.message }) });
      if (!outcome.ok) return outcomeToActionResult(meta.commandId, outcome, Math.max(1, core.now() - t0));
      const fg = core.foreground !== null ? core.windows.get(core.foreground) : undefined;
      return core.ok(meta.commandId, fg ? { observation: { via: "a11y", window: fg.title, text: (fg.text || fg.title).slice(-500) } } : undefined);
    },
  };
}
