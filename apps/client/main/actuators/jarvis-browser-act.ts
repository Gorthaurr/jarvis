/**
 * B-2 + п.6 (W4): web_act невидимого браузера — ТЕ ЖЕ page-функции, что у расширения (apps/extension/page/*.js), через
 * CDP. Было (свой eval): селектор не найден → печать в ТЕКУЩИЙ фокус и «ok»; поле пароля не проверялось; клик по тексту
 * голым .includes («да» → «Удалить»); Enter и клик без гарда §14 на странице. Стало:
 *  - type/key → elementActIsolated в изолированном мире главного фрейма (мир создаётся на каждое действие — после
 *    навигации прежний умер): строгая цель (not_found — в фокус не печатает), §0 secret_field, гард Enter/отправки;
 *  - click → robustClickMain в MAIN (видит React-props): скоринг текста без подстрок, гард подписи цели → commit_confirm;
 *  - отказ страницы → ActionError: not_found | denied (+ data.pageCode/label — сервер спросит владельца и повторит).
 * Функции самодостаточны (закон page/*.js): в страницу уходит их toString() с JSON-аргументами.
 */
import { promises as fsp } from "node:fs";
import { basename } from "node:path";
import { elementActIsolated } from "../../../extension/page/element-act.js";
import { robustClickMain } from "../../../extension/page/robust-click.js";
import { ActionError } from "./action-error.js";
import type { CdpConn } from "./cdp-conn.js";
import { unwrapEvalResult } from "./cdp-core.js";
import { expandPath } from "./fs.js";
import { assertReadable } from "./self-guard.js";

type PageReply = { ok?: boolean; code?: string; error?: string; label?: string } & Record<string, unknown>;
export type WebActOutcome = Record<string, unknown> & { ok: true };

const ELEMENT_SRC = elementActIsolated.toString();
const CLICK_SRC = robustClickMain.toString();
/** Служебные поля §14 — ставит ТОЛЬКО сервер (handlers/web-act.ts вырезает их у модели и добавляет после «да»). */
const GUARD_FIELDS = ["guard", "guardApproved", "approvedLabel"];
const CONTEXT_DIED = /context was destroyed|cannot find context|navigated or closed|execution context/iu;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pick(params: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (params[k] !== undefined) out[k] = params[k];
  return out;
}

async function evalIn(cdp: CdpConn, src: string, args: unknown[], contextId?: number): Promise<PageReply> {
  const expression = `(${src})(...${JSON.stringify(args)})`;
  const raw = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) });
  const r = unwrapEvalResult<PageReply | undefined>(raw, "web_act");
  if (!r || typeof r !== "object") throw new Error("web_act: страница не вернула исход действия");
  return r;
}

async function isolatedWorld(cdp: CdpConn, frameId: string): Promise<number> {
  const w = (await cdp.send("Page.createIsolatedWorld", { frameId, worldName: "jarvis-web-act" })) as { executionContextId?: number };
  if (!w?.executionContextId) throw new Error("web_act: не создал изолированный мир страницы — ничего не делал");
  return w.executionContextId;
}

/** Отказ страницы → протокольный исход. Код и подпись commit_confirm — в data (подпись задаёт страница: сервер не пересказывает её модели). */
function pageFailure(intent: string, r: PageReply): never {
  const code = typeof r.code === "string" ? r.code : "";
  const proto = code === "not_found" ? "not_found" : code === "secret_field" || code === "commit_confirm" ? "denied" : "runtime";
  const data = code ? { pageCode: code, ...(typeof r.label === "string" ? { label: r.label } : {}) } : undefined;
  throw new ActionError(`web_act ${intent}: ${String(r.error ?? "не вышло").slice(0, 300)}`, { code: proto, data });
}

/** Действие + честный исход смерти контекста посреди него (переход страницы). */
async function run(cdp: CdpConn, intent: string, act: () => Promise<PageReply>): Promise<WebActOutcome> {
  const before = await cdp.evaluate<string>("location.href").catch(() => "");
  let r: PageReply;
  try {
    r = await act();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!CONTEXT_DIED.test(msg)) throw e;
    await sleep(400);
    const after = await cdp.evaluate<string>("location.href").catch(() => "");
    if (!after || after === before) throw e;
    // Клик увёл страницу — переход вероятен, исход самого клика НЕ подтверждён (как у расширения).
    if (intent === "click") return { ok: true, navigated: after, uncertain: true, note: "страница перешла во время действия — исход не подтверждён" };
    // Ввод/клавиша: действие ушло, страница сменилась посреди — «неизвестно», не «не вышло» и не «сделал».
    throw new ActionError(`web_act ${intent}: страница перешла посреди действия — исход не подтверждён`, { code: "runtime", injected: true });
  }
  if (r.ok !== true) pageFailure(intent, r);
  return r as WebActOutcome;
}

async function upload(cdp: CdpConn, params: Record<string, unknown>): Promise<WebActOutcome> {
  // Файл с диска в <input type=file> (DOM.setFileInputFiles) — без лимита размера. Путь от модели → секреты не отдаём.
  const path = String(params.path ?? "").trim();
  if (!path) throw new Error("upload: нужен params.path (файл на диске)");
  const abs = expandPath(path);
  assertReadable(abs);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`upload: файла «${abs}» нет или это не файл`);
  const selector = String(params.selector ?? "input[type=file]");
  const doc = (await cdp.send("DOM.getDocument", { depth: 1 })) as { root?: { nodeId?: number } };
  const rootId = doc?.root?.nodeId;
  if (!rootId) throw new Error("upload: не получил DOM-документ страницы");
  const q = (await cdp.send("DOM.querySelector", { nodeId: rootId, selector })) as { nodeId?: number };
  if (!q?.nodeId) throw new ActionError(`upload: элемент «${selector}» не найден — сначала открой форму загрузки (web_read{view:'elements'} покажет input[type=file])`, { code: "not_found" });
  await cdp.send("DOM.setFileInputFiles", { nodeId: q.nodeId, files: [abs] });
  return { ok: true, note: `upload ${basename(abs)} (${Math.round(st.size / 1024)} КБ) в ${selector}` };
}

/** web_act: click | type | key | scroll | upload в главном фрейме вкладки невидимого браузера. */
export async function webAct(cdp: CdpConn, mainFrameId: string, intent: string, params: Record<string, unknown> = {}): Promise<WebActOutcome> {
  if (intent === "upload") return upload(cdp, params);
  if (intent === "scroll") {
    await cdp.evaluate(`window.scrollBy(0, ${Number(params.dy) || 600})`);
    return { ok: true };
  }
  if (intent === "click") {
    const cp = pick(params, ["selector", "text", ...GUARD_FIELDS]);
    return run(cdp, intent, () => evalIn(cdp, CLICK_SRC, [cp]));
  }
  if (intent === "type" || intent === "key") {
    const own = intent === "type" ? pick(params, ["selector", "text", "enter"]) : { ...pick(params, ["selector"]), combo: String(params.combo ?? params.key ?? "Enter") };
    const ep = { ...own, ...pick(params, GUARD_FIELDS) };
    return run(cdp, intent, async () => evalIn(cdp, ELEMENT_SRC, [null, intent, ep], await isolatedWorld(cdp, mainFrameId)));
  }
  throw new Error(`web_act: неизвестный intent «${intent}»`);
}
