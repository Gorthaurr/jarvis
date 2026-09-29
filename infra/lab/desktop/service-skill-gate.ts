/**
 * Рубеж §14 для шагов навыка в лаборатории. Те же функции, что у клиента (guiProcessCategory / opCommitIntent /
 * matchGrants / approvalDenial): шаг-коммит (Enter в мессенджере, «Отправить» в банке) без гранта СЕРВЕРНОЙ команды
 * не исполняется — `denied` + `data.needsApproval`; есть грант — списывается (одно «да» — одно действие).
 * Факты об элементе берём из target шага (роль+имя) — по handle/координатам лаборатория элемент не знает (пробел).
 */
import type { CommitApproval, CommitGrant, SkillStep } from "@jarvis/protocol";
import { type CommitIntent, guiProcessCategory, opCommitIntent } from "@jarvis/shared";
import { ActionError } from "../../../apps/client/main/actuators/action-error.js";
import type { ApprovalScope } from "../../../apps/client/main/actuators/approval-scope.js";
import { type Judged, approvalDenial, matchGrants } from "../../../apps/client/main/actuators/commit-approval.js";
import type { DesktopCore } from "./core.js";
import { str } from "./service-state.js";

const validGrant = (g: CommitGrant): boolean => g && typeof g.signature === "string" && typeof g.process === "string" && Number.isFinite(g.count) && g.count > 0;

/** Судья шагов одной команды skill.execute. Возвращает одобрение, которое надо переслать вложенной команде (или undefined). */
export type StepGate = (step: SkillStep) => CommitApproval | undefined;

export function createStepGate(core: DesktopCore, approval: CommitApproval | undefined): StepGate {
  const grantsLeft: CommitGrant[] = (approval?.grants ?? []).filter(validGrant).map((g) => ({ ...g, count: Math.floor(g.count) }));
  const scope: ApprovalScope = { via: "server", ...(approval ? { approval, grantsLeft } : {}) };

  return (step) => {
    const fg = core.foreground !== null ? core.windows.get(core.foreground) : undefined;
    if (!fg) return undefined;
    const cat = guiProcessCategory(fg.process, fg.title);
    if (!cat) return undefined; // обычная программа — §14 не судит
    const p = step.params ?? {};
    const el = step.target?.by === "role" ? { role: step.target.role, ...(step.target.name ? { name: step.target.name } : {}) } : undefined;
    let intents: CommitIntent[] = [];
    if (step.action === "input.type") intents = cat.human === "почта" ? [] : opCommitIntent("type", p, { category: cat.category });
    else if (step.action === "input.key") intents = opCommitIntent("key", p, { category: cat.category });
    else if (step.action === "input.click") intents = opCommitIntent("click", p, { category: cat.category, ...(el ? { element: el } : {}) });
    else if (step.action === "ui.invoke") intents = opCommitIntent("invoke", p, { category: cat.category, ...(el ? { element: el } : {}) });
    if (!intents.length) return undefined;

    const proc = { pid: fg.pid, process: fg.process, title: fg.title, hwnd: fg.hwnd };
    const judged: Judged[] = intents.map((intent) => ({ intent, proc, category: cat.category, human: cat.human }));
    const m = matchGrants(scope, judged);
    if ("missing" in m) {
      const denial = approvalDenial(scope, m.missing, step.action === "input.type" ? `${fg.text}${str(p.text)}`.slice(-200) : fg.text.slice(-200));
      throw new ActionError(denial.message, { code: "denied", ...(denial.data !== undefined ? { data: denial.data } : {}) });
    }
    const forward: CommitGrant[] = m.take.map(([g, n]) => ({ ...g, count: n }));
    for (const [g, n] of m.take) g.count -= n;
    return { grants: forward, expiresAt: approval?.expiresAt ?? 0 };
  };
}
