/**
 * B-2 + п.6 (W4): web_act (НЕВИДИМЫЙ браузер Джарвиса) — свой хендлер по образцу browserAct. Было (инлайн в dispatch):
 * сервер судил только опасные хосты по тексту, на обычном хосте клик по селектору «Удалить навсегда» не судил никто, а
 * `params` модели уходили клиенту целиком (схема — открытый объект): гард на странице наивно добавить было нельзя —
 * модель прислала бы `guardApproved:true` сама. Стало:
 *  1. поля модели — ТОЛЬКО allowlist интента (служебные guard/guardApproved/approved* вырезаются);
 *  2. место — дочитанный адрес страницы (клик уводит), опасный хост/LMS — вопрос ДО действия (assessWebCommit);
 *  3. гард страницы (pageGuardFor) — на ЛЮБОМ хосте: страница узнала коммит → commit_confirm с подписью →
 *     один вопрос владельцу и ОДИН повтор с approvalFields; снова commit_confirm → «кнопка сменилась», не жмём.
 * Результат — внутри <untrusted_content> (M11), адрес после действия помечается протухшим.
 */
import { type ActionCommand, type ActionResult, actionTimeoutMs } from "@jarvis/protocol";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { err, overlayDeniedResult, untrustedCapped } from "../dispatch-util.js";
import { assessWebCommit, hostOfUrl, lastWebTarget } from "../commit-gate.js";
import { approvalFields, commitApprovalLabel, confirmWebCommit, pageCommitRisk, pageGuardFor } from "../web-commit-guard.js";
import { type WebPlace, markWebTargetStale, refreshWebTarget } from "../web-place.js";
import { injectedFailure } from "../injected-outcome.js";
import { pageErrorBlock, secretFieldRefusal } from "./browser-failure.js";

/** Поля модели по интенту (плоско или в params). Всё прочее, включая служебные поля §14, до клиента не доходит. */
const FIELDS: Record<string, readonly string[]> = {
  click: ["selector", "text"],
  type: ["selector", "text", "enter"],
  key: ["key", "combo", "selector"],
  scroll: ["dy"],
  upload: ["path", "selector"],
};
/** Интенты, которые жмут цель/отправляют: им страница судит подпись (scroll/upload ничего не жмут). */
const GUARDED: ReadonlySet<string> = new Set(["click", "type", "key"]);

export function webActParams(intent: string, input: Record<string, unknown>): Record<string, unknown> {
  const own = input.params && typeof input.params === "object" && !Array.isArray(input.params) ? (input.params as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const k of FIELDS[intent] ?? []) {
    const v = own[k] ?? input[k];
    if (v !== undefined) out[k] = v;
  }
  if (intent === "key") return { combo: String(out.combo ?? out.key ?? "").trim() || "Enter", ...(out.selector !== undefined ? { selector: out.selector } : {}) };
  return out;
}

/** Подпись из отказа страницы commit_confirm (клиент кладёт её в data.label); иначе null. */
function commitConfirmOf(r: ActionResult): string | null {
  const d = (r.data ?? {}) as { pageCode?: unknown; label?: unknown };
  return !r.ok && d.pageCode === "commit_confirm" ? String(d.label ?? "").trim() : null;
}

async function placeOf(ctx: ToolContext, intent: string): Promise<WebPlace> {
  const sess = ctx.session as unknown as object;
  if (!lastWebTarget(sess)) markWebTargetStale(ctx); // адрес ещё не знаем — дочитаем, а не судим вслепую
  if (GUARDED.has(intent)) await refreshWebTarget(ctx);
  const url = lastWebTarget(sess);
  const host = hostOfUrl(url);
  return { url, host, unknown: !host };
}

export async function webAct(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const intent = String(input.intent ?? "").trim();
  if (!FIELDS[intent]) return err(`web_act: intent «${intent.slice(0, 20)}» не поддержан — click | type | key | scroll | upload.`);
  const params = webActParams(intent, input);
  const place = await placeOf(ctx, intent);
  const label = commitApprovalLabel(intent, params);
  const risk = assessWebCommit({ host: place.host, url: place.url, unknownSite: place.unknown, intent, params, label });
  if (risk) {
    const decision = await confirmWebCommit(ctx, place, risk, label);
    if (decision !== true) return decision;
  }
  const guard = GUARDED.has(intent) ? pageGuardFor(place) : undefined;
  const send = (p: Record<string, unknown>): Promise<ActionResult> =>
    ctx.session.sendAction({ kind: "jbrowser.act", intent, params: p, origin: ctx.origin ?? "user" } as ActionCommand, actionTimeoutMs("jbrowser.act"));
  let r = await send(guard ? { ...params, guard, ...(risk ? approvalFields(label) : {}) } : params);
  const pageLabel = guard ? commitConfirmOf(r) : null;
  if (pageLabel !== null) {
    // Страница узнала коммит (подпись видна только ей) и НЕ нажала — спрашиваем и повторяем ОДИН раз.
    const decision = await confirmWebCommit(ctx, place, pageCommitRisk(place, pageLabel), pageLabel);
    if (decision !== true) return decision;
    r = await send({ ...params, guard, ...approvalFields(pageLabel) });
    if (commitConfirmOf(r) !== null) return err("web_act: пока ждал подтверждения, кнопка на странице сменилась — не нажимал. Сделай web_read{view:'elements'} и повтори.");
  }
  markWebTargetStale(ctx); // действие могло увести страницу — перед следующим коммитом адрес дочитаем
  return r.ok ? webActDone(intent, r) : webActFailed(intent, r);
}

function webActDone(intent: string, r: ActionResult): ToolResult {
  const d = (r.data ?? {}) as { uncertain?: unknown; changed?: unknown; blockedNav?: unknown };
  const head =
    d.uncertain === true
      ? `Похоже, страница ПЕРЕШЛА во время «${intent}», исход действия НЕ подтверждён — сверь web_read прежде чем говорить «готово».`
      : `Сделал «${intent}» в браузере Джарвиса.${d.changed === false ? " ВНИМАНИЕ: страница не отреагировала — сверь web_read." : ""}`;
  const blocked = typeof d.blockedNav === "string" ? ` Переход на внутренний адрес ЗАБЛОКИРОВАН (B-14) — там ничего не открыто.` : "";
  const out = untrustedCapped("jarvis-browser", JSON.stringify(r.data ?? { ok: true }), "Сузь: web_inspect{query} или читай нужный фрагмент.");
  out.content = `${head}${blocked}\n${out.content}`;
  if (r.data !== undefined) out.data = r.data;
  return out;
}

function webActFailed(intent: string, r: ActionResult): ToolResult {
  const special = overlayDeniedResult(r) ?? injectedFailure(`web_act «${intent}»`, r); // часть ушла → исход неизвестен
  if (special) return special;
  const code = (r.data as { pageCode?: unknown } | undefined)?.pageCode;
  if (code === "secret_field") return secretFieldRefusal(`web_act «${intent}»`);
  if (r.error?.code === "channel_down") {
    const out = err("web_act не отправлен: канал с ПК временно недоступен (переподключение). Не провал — жду восстановления.");
    out.channelDown = true;
    return out;
  }
  const msg = pageErrorBlock("web-act-error", r.error?.message ?? r.error?.code ?? "сбой");
  if (r.error?.code === "not_found") return err(`web_act «${intent}»: цель на странице не найдена — НИЧЕГО не делал (в фокус не печатал). Сверь web_read{view:'elements'} и укажи selector/текст.\n${msg}`);
  return err(`web_act «${intent}» не вышло.\n${msg}`);
}
