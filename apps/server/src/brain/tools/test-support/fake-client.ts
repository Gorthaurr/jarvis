/**
 * W2 П3: фейковый КЛИЕНТ в реальной форме ответов — для тестов серверных гейтов через настоящий dispatchTool.
 *
 * Отвечает как клиент после W2: `ui.snapshot` — элементы с handle ЧИСЛОМ; `screen.capture` — кадр с frameId; мутация, которую «рубеж» считает коммитом
 * (`need`), без гранта в `cmd.approval` (подпись + процесс + окно через `findGrant` из shared, срок не истёк) →
 * `denied` + `data.needsApproval` (форма протокола), с `stepIndex` у skill.execute и `stepActionInjected` по сценарию.
 * Грант есть → ok. Журнал `sent` — всё, что реально ушло «на ПК».
 */
import type { ActionCommand, ActionResult, NeedsApproval, SkillStep } from "@jarvis/protocol";
import { findGrant } from "@jarvis/shared";

export interface Need {
  signature: string;
  process: string;
  hwnd?: number;
  category?: string;
  windowTitle?: string;
  pendingText?: string;
  /** Часть действия уже ушла, когда рубеж остановил коммит. */
  injected?: boolean;
}

export interface FakeClientOpts {
  snapshot?: Array<{ handle: number; role: string; name: string; value?: string; automationId?: string }>;
  /** Коммит одиночной команды (или шага skill.execute): null — не коммит. */
  need?: (cmd: ActionCommand | SkillStep) => Need | null;
}

export function fakeClient(opts: FakeClientOpts = {}): { sent: ActionCommand[]; sendAction: (cmd: ActionCommand, timeoutMs?: number) => Promise<ActionResult> } {
  const sent: ActionCommand[] = [];
  let frames = 0;
  const ok = (data?: unknown): ActionResult => ({ commandId: "c", ok: true, durationMs: 1, ...(data !== undefined ? { data } : {}) });
  /** Грант списывается (count) — как в области одобрения клиента: одно «да» на одно действие. */
  const grantsLeft = (cmd: ActionCommand) => (cmd.approval && cmd.approval.expiresAt > Date.now() ? cmd.approval.grants.map((g) => ({ ...g })) : []);
  const take = (left: ReturnType<typeof grantsLeft>, n: Need): boolean => {
    const g = findGrant(left, { signature: n.signature, process: n.process, hwnd: n.hwnd });
    if (g) g.count -= 1;
    return g !== null;
  };
  const denied = (n: Need, stepIndex?: number): ActionResult => {
    const needsApproval: NeedsApproval = {
      category: n.category ?? "messenger",
      process: n.process,
      what: "действие",
      signature: n.signature,
      ...(n.hwnd !== undefined ? { hwnd: n.hwnd } : {}),
      ...(n.windowTitle ? { windowTitle: n.windowTitle } : {}),
      ...(n.pendingText ? { pendingText: n.pendingText } : {}),
    };
    return {
      commandId: "c",
      ok: false,
      durationMs: 1,
      error: { code: "denied", message: "нужно одобрение владельца" },
      data: { needsApproval },
      ...(stepIndex !== undefined ? { stepIndex } : {}),
      ...(n.injected ? { stepActionInjected: true } : {}),
    };
  };
  const sendAction = async (cmd: ActionCommand): Promise<ActionResult> => {
    sent.push(cmd);
    if (cmd.kind === "ui.snapshot") return ok({ items: (opts.snapshot ?? []).map((x) => ({ automationId: "", value: "", bbox: { x: 1, y: 2, w: 3, h: 4 }, ...x })) });
    // W2 П5: полный кадр — с меткой (frameId), как у клиентского screen.capture; координаты модели — в нём.
    if (cmd.kind === "screen.capture") return ok({ image: "AAAA", mediaType: "image/png", width: 1920, height: 1080, frameId: `f${(frames += 1)}` });
    const left = grantsLeft(cmd);
    if (cmd.kind === "skill.execute") {
      for (let i = 0; i < cmd.steps.length; i += 1) {
        const n = opts.need?.(cmd.steps[i]!);
        if (n && !take(left, n)) return denied(n, i);
      }
      return ok();
    }
    const n = opts.need?.(cmd);
    return n && !take(left, n) ? denied(n) : ok();
  };
  return { sent, sendAction };
}
