/**
 * Рубеж §14 FakeDesktop: та же логика, что у настоящего клиента (commit-judge), на ТЕХ ЖЕ функциях `@jarvis/shared`
 * (категория процесса, намерения-коммиты, подпись, поиск гранта). Гранты берутся из `cmd.approval` (ставит сервер);
 * нет гранта на необратимое (Enter/«Отправить» в мессенджере, банке…) → `denied` + `data.needsApproval`, НИЧЕГО не нажато.
 * Не воспроизведено (см. gaps): §0-судья секретов и суд памяти зеркала handle; «свой процесс» — отказ без вопроса есть.
 */
import type { ActionCommand, CommitGrant, NeedsApproval } from "@jarvis/protocol";
import { type CommitIntent, type ElementFacts, canonicalProcess, findGrant, guiProcessCategory, opCommitIntent, actCommitIntent, normRole } from "@jarvis/shared";
import type { InjectOp } from "@jarvis/shared";
import type { DesktopWindow } from "../lib/contracts.js";
import { ActionError } from "./gui-state.js";

/** Гранты ОДНОЙ команды (копия: счётчик списывается по мере действий внутри команды, как область одобрения клиента). */
export interface Scope {
  grants: CommitGrant[];
}

export function scopeOf(cmd: ActionCommand): Scope {
  const a = cmd.approval;
  const live = a && typeof a.expiresAt === "number" ? a.expiresAt > Date.now() : Boolean(a);
  return { grants: live && a ? a.grants.map((g) => ({ ...g })) : [] };
}

export interface Fact {
  op: InjectOp;
  params: Record<string, unknown>;
  w: DesktopWindow | undefined;
  element?: ElementFacts;
  focused?: ElementFacts;
  /** Что уже набрано в поле (для вопроса владельцу «что уйдёт»). */
  pending?: string;
}

const clean = (s: string | undefined, n: number): string => String(s ?? "").replace(/[\u0000-\u001f\u007f«»"'`“”„]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, n);
const TEXT_ROLES = new Set(["edit", "document"]);

export function grantProcess(w: DesktopWindow): string {
  return canonicalProcess(w.process) ?? canonicalProcess(w.title) ?? w.process.trim().toLowerCase().replace(/\.exe$/u, "");
}

function whatOf(i: CommitIntent): string {
  const times = i.count > 1 ? ` ×${i.count}` : "";
  if (i.signature.startsWith("key:")) return `клавиша «${i.signature.slice(4)}»${times}`;
  const label = i.signature.slice("click:".length);
  return label.startsWith("?") ? `нажатие безымянного элемента (${label.slice(1)})${times}` : `нажатие «${label}»${times}`;
}

function intentsOf(f: Fact, cat: { category: string; human: string }): CommitIntent[] {
  const category = cat.category as Parameters<typeof opCommitIntent>[2]["category"];
  if (f.op === "type" && cat.human === "почта") return []; // перевод строки в письме — абзац, не отправка
  if (f.op === "key" && category === "remote") return actCommitIntent({ combo: f.params.combo, mode: f.params.mode }, { category, tool: "input_key" });
  const isEnter = /(^|\+)\s*(enter|return)\s*$/iu.test(String(f.params.combo ?? "").trim());
  if (f.op === "key" && cat.human === "почта" && isEnter && f.focused && TEXT_ROLES.has(normRole(f.focused.role))) return [];
  return opCommitIntent(f.op, f.params, { category, ...(f.element ? { element: f.element } : {}), ...(f.focused ? { focused: f.focused } : {}) });
}

/**
 * Судить действия. `preflight` — только проверка (грант не списывается): ранняя проверка клавишных намерений act ДО
 * первого клика. Отказ — ActionError denied; после успеха гранты списаны.
 */
export function judge(scope: Scope, facts: Fact[], preflight = false): void {
  const wanted: Array<{ intent: CommitIntent; w: DesktopWindow; cat: { category: string; human: string }; pending?: string }> = [];
  for (const f of facts) {
    if (!f.w) continue;
    if (/^(jarvis|electron)$/iu.test(f.w.process.replace(/\.exe$/iu, ""))) {
      throw new ActionError("§0: это окно самого Джарвиса — управлять им я не буду; ничего не нажато", "denied");
    }
    const cat = guiProcessCategory(f.w.process, f.w.title);
    if (!cat) continue; // обычная программа — §14 не судит
    for (const intent of intentsOf(f, cat)) wanted.push({ intent, w: f.w, cat, pending: f.pending });
  }
  const take: Array<[CommitGrant, number]> = [];
  for (const j of wanted) {
    const used = (g: CommitGrant): number => take.filter(([t]) => t === g).reduce((a, [, n]) => a + n, 0);
    const left = scope.grants.filter((g) => g.count - used(g) >= j.intent.count);
    const g = findGrant(left, { signature: j.intent.signature, process: grantProcess(j.w), hwnd: j.w.hwnd });
    if (!g) throw denial(j);
    take.push([g, j.intent.count]);
  }
  if (!preflight) for (const [g, n] of take) g.count -= n; // одно «да» — одно действие
}

function denial(j: { intent: CommitIntent; w: DesktopWindow; cat: { category: string; human: string }; pending?: string }): ActionError {
  const title = clean(j.w.title, 60);
  const what = whatOf(j.intent);
  const needsApproval: NeedsApproval = {
    category: j.cat.category,
    process: grantProcess(j.w),
    hwnd: j.w.hwnd,
    ...(title ? { windowTitle: title } : {}),
    what,
    signature: j.intent.signature,
    ...(j.pending ? { pendingText: clean(j.pending, 200) } : {}),
  };
  return new ActionError(`§14: ${what} в «${title || j.w.process}» (${j.cat.human}) — необратимое действие, нужно «да» владельца; ничего не нажато.`, "denied", { needsApproval });
}
