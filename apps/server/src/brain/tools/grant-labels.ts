/**
 * Подписи цели для гранта «поручение = разрешение» (task-grant.ts): ВСЕ видимые (снимок + слова модели), а ref, которого нет
 * в снимках сессии (реконнект/вытеснение), — пустой список: подписи не знаем, грант не применяется (ревью 28.09, #1/#8).
 */
import type { ToolContext } from "./dispatch.js";
import { webCommitLabelParts } from "./commit-gate.js";
import { refApprovalLabel } from "./handlers/browser-refs.js";

export function grantLabelsFor(ctx: ToolContext, intent: string, params: Record<string, unknown>, snapshotLabels: string | readonly string[] | undefined): string[] {
  const ref = params.ref;
  if (typeof ref === "string" && ref.length > 0 && !refApprovalLabel(ctx, ref)) return [];
  return webCommitLabelParts(intent, params, snapshotLabels);
}
