/**
 * W2 П1 (решение №3): ОДОБРЕНИЕ §14 на клиенте — грант из области серверной команды или честный отказ с вопросом.
 *
 * Грант = {signature, process, hwnd?, count} (+ срок области). Подпись и процесс — функции shared (одна формула с
 * сервером); hwnd — если грант к окну привязан. Нет гранта в серверной команде → `denied` + `needsApproval` (вопрос
 * строит сервер, строки с экрана тут уже подрезаны). Мост, локальный реплей и путь вне области гранта не имеют →
 * отказ без вопроса: мост — «используй штатный инструмент (в браузере — browser_act)», реплей — «запусти через Джарвиса».
 */
import type { CommitGrant, NeedsApproval } from "@jarvis/protocol";
import { type CommitIntent, canonicalProcess, findGrant } from "@jarvis/shared";
import { type ApprovalScope, liveGrants } from "./approval-scope.js";
import type { JudgeDenial } from "./injection-guard.js";
import type { ProcFact } from "./process-of.js";

export interface Judged {
  intent: CommitIntent;
  proc: ProcFact;
  category: string;
  human: string;
}

/** Процесс гранта: канон образа; UWP-хост (ApplicationFrameHost) — по заголовку; прочее — имя образа. */
export function grantProcess(p: ProcFact): string {
  return canonicalProcess(p.process) ?? canonicalProcess(p.title) ?? p.process.trim().toLowerCase().replace(/\.exe$/u, "");
}

/** Строка с экрана в вопрос владельцу: без кавычек, переводов строки и управляющих, ≤ n символов. */
export function cleanScreenText(s: string | undefined, n: number): string {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f«»"'`“”„]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, n);
}

/** Человеко-описание намерения: «клавиша «Enter» ×2», «нажатие «Отправить»». */
export function whatOf(i: CommitIntent): string {
  const times = i.count > 1 ? ` ×${i.count}` : "";
  if (i.signature.startsWith("key:")) return `клавиша «${i.signature.slice(4)}»${times}`;
  const label = i.signature.slice("click:".length);
  return label.startsWith("?") ? `нажатие безымянного элемента (${label.slice(1)})${times}` : `нажатие «${label}»${times}`;
}

/** Гранты на ВСЕ намерения (с кратностью). Нашлось — список к списанию; нет — первое непокрытое. */
export function matchGrants(scope: ApprovalScope | undefined, judged: readonly Judged[]): { take: Array<[CommitGrant, number]> } | { missing: Judged } {
  const grants = liveGrants(scope);
  const take: Array<[CommitGrant, number]> = [];
  for (const j of judged) {
    const left = grants.filter((g) => g.count - take.filter(([t]) => t === g).reduce((a, [, n]) => a + n, 0) >= j.intent.count);
    const g = findGrant(left, { signature: j.intent.signature, process: grantProcess(j.proc), hwnd: j.proc.hwnd });
    if (!g) return { missing: j };
    take.push([g, j.intent.count]);
  }
  return { take };
}

/** Отказ по непокрытому намерению: в серверной команде — с вопросом; мост/реплей/UI — без (спросить некому). */
export function approvalDenial(scope: ApprovalScope | undefined, j: Judged, pendingText: string): JudgeDenial {
  const what = whatOf(j.intent);
  const title = cleanScreenText(j.proc.title, 60);
  const where = `в «${title || j.proc.process}» (${j.human})`;
  if (scope?.via === "server") {
    const needsApproval: NeedsApproval = {
      category: j.category,
      process: grantProcess(j.proc),
      ...(j.proc.hwnd !== undefined ? { hwnd: j.proc.hwnd } : {}),
      ...(title ? { windowTitle: title } : {}),
      what,
      signature: j.intent.signature,
      ...(pendingText ? { pendingText: cleanScreenText(pendingText, 200) } : {}),
    };
    return { message: `§14: ${what} ${where} — необратимое действие, нужно «да» владельца; ничего не нажато.`, data: { needsApproval } };
  }
  const path =
    scope?.via === "bridge"
      ? j.category === "web"
        ? "SDK-мост его не делает: в браузере — инструмент browser_act (сервер спросит владельца)"
        : "SDK-мост его не делает: используй штатный инструмент act/input_key (сервер спросит владельца) или заверши без отправки"
      : "без одобрения владельца (локальный реплей/вне команды сервера) не делаю: запусти через Джарвиса — он спросит владельца";
  return { message: `§14: ${what} ${where} — необратимое действие; ${path}. Ничего не нажато.` };
}

/** Процесс цели не определён, а действие — кандидат в коммит: честно, без вопроса (спросить не о чем). */
export function unknownProcessDenial(i: CommitIntent, unknownHandle?: string): JudgeDenial {
  if (unknownHandle !== undefined) {
    return { message: `§14: handle ${unknownHandle.slice(0, 12)} неизвестен (снапшот старый или сайдкар перезапущен) — не знаю, что и где нажмётся; сними ui_snapshot заново. Ничего не нажато.` };
  }
  return { message: `§14: ${whatOf(i)} — не смог определить программу цели, а это может быть отправка; укажи app (в какой программе). Ничего не нажато.` };
}
