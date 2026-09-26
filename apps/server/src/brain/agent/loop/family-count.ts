// W1 (L-1, L-12): учёт СЕМЕЙНОГО anti-runaway по каждому вызову раунда (сам порог и нудж — anti-runaway.ts familyCap).
// Было: счёт по сырому ИМЕНИ за задачу — 14 разных browser_act-кликов давали на 6-м нудж «топтание», на 12-м обрыв
// «Застрял на browser_act»: тест в Moodle / форма из ≥12 полей были физически невозможны, хотя персона сама велит серию.
// Стало:
//  • РУКИ (слепые mutate) — по СИГНАТУРЕ цели (имя + вход без значения поля): первая встреча цели бесплатна, повтор
//    считается. Долбёжка одной кнопки (даже вперемешку с другими действиями) по-прежнему упирается в кап; подряд
//    одинаковые раунды по-прежнему ловит antiRunawayIdentical.
//  • Рука с ПОДТВЕРЖДЁННЫМ эффектом (observed — readback поля/навигация) не считается вовсе: это не топтание.
//  • ПРОГРЕСС обнуляет счётчики рук и глаз: взгляд, увидевший ПОСЛЕ действия руки НОВОЕ состояние (хеш содержимого
//    без ref-токенов). Новая страница = новые цели, а ref на ней могут совпасть со старыми (реестр расширения живёт
//    в документе). Тот же вид после действия — топтание: счёт идёт дальше (и у руки, и у взгляда).
//  • Имя — КАНОНИЧЕСКОЕ (вызов уже канонизирован в tool-round): look{elements} и look{text} — разные семейства (L-12).
import { createHash } from "node:crypto";
import type { LoopCtx } from "./context.js";
import type { LoopState } from "./state.js";
import type { RoundResult } from "./tool-round.js";
import type { ToolResult } from "../../tools/dispatch.js";
import type { LlmResponse } from "../../../integrations/llm.js";
import { isBlindMutate, toolEffect } from "../error-voice.js";
import { repeatSignature } from "../repeat-key.js";

/** Значение поля — не цель: set одного поля разными значениями — повтор цели, а не новая цель. */
const PAYLOAD_KEYS = new Set(["value", "checked", "option"]);

function stripPayload(v: unknown, typing = false): unknown {
  if (Array.isArray(v)) return v.map((x) => stripPayload(x));
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  // У набора текста (intent/do "type") `text` — содержимое, а не цель (у click `text` — цель, его оставляем).
  const isTyping = typing || o.intent === "type" || o.do === "type";
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) {
    if (PAYLOAD_KEYS.has(k) || (isTyping && k === "text")) continue;
    out[k] = stripPayload(x, isTyping && k === "params");
  }
  return out;
}

/** Сигнатура ЦЕЛИ руки (имя + нормализованный вход без значения поля). */
export function handSignature(name: string, input: unknown): string {
  return repeatSignature([{ name, input: stripPayload(input) }]);
}

/** ref-токены (`e3_5`, `f2e3_5`) растут с каждым снимком — в хеш вида не входят, иначе «новым» был бы любой взгляд. */
const REF_TOKEN = /\b(?:f\d+)?e\d+_\d+\b/gu;
/** Позиция плеера (browser_read, handlers/browser.ts) тикает сама по себе — это не новый вид страницы. */
const PLAYER_LINE = /\[Плеер[^\]\n]*\]/gu;
/**
 * Хеш ТЕКСТОВОЙ сути взгляда (W1-ревью LOOP-1). Картинка (base64 скриншота/снимка вкладки) другая на каждом кадре, а
 * строка плеера — каждую секунду: хеш по ним звал «прогрессом» любой взгляд, и долбёжка одной кнопки на живой странице
 * (видео, анимация) обнуляла семейный счёт навсегда.
 */
function lookDigest(content: ToolResult["content"]): string {
  const text = typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  return createHash("sha1").update(text.replace(PLAYER_LINE, "").replace(REF_TOKEN, "ref")).digest("hex");
}

/** Прогресс: счётчики рук и глаз — с нуля, все цели снова «первые». Нейтральные (поиск/память) не трогаем. */
function resetPageFamily(st: LoopState): void {
  st.nudge.seenHandSigs.clear();
  for (const name of [...st.nudge.toolNameCount.keys()]) {
    if (isBlindMutate(name) || toolEffect(name) === "verify") st.nudge.toolNameCount.delete(name);
  }
}

const bump = (st: LoopState, name: string): void => {
  st.nudge.toolNameCount.set(name, (st.nudge.toolNameCount.get(name) ?? 0) + 1);
};

/** Учесть ОДИН (канонический) вызов раунда в семейном счётчике. */
export function countFamilyCall(ctx: LoopCtx, tu: LlmResponse["toolUses"][number], r: ToolResult, eff: "verify" | "mutate" | "neutral", round: RoundResult): void {
  const { st } = ctx;
  // контроль-3/5/9: отказ вуали, опрос под ней и опрос идущего задания — состояние системы, не «топтание»
  if (round.overlayDeniedIds.has(tu.id) || round.veiledIds.has(tu.id) || round.backgroundRunningIds.has(tu.id)) return;
  if (tu.name === "file_view") {
    const inp = tu.input as { path?: unknown; page?: unknown };
    const sig = `${String(inp.path ?? "")}#${String(inp.page ?? 1)}`;
    if (!st.nudge.seenFileViews.has(sig)) {
      st.nudge.seenFileViews.add(sig);
      return;
    }
  }
  if (eff === "verify" && !r.isError && r.empty !== true) {
    const digest = lookDigest(r.content);
    const prev = st.nudge.lookDigests.get(tu.name);
    st.nudge.lookDigests.set(tu.name, digest);
    if (st.nudge.handActedSinceLook && prev !== undefined && prev !== digest) resetPageFamily(st);
    st.nudge.handActedSinceLook = false;
  }
  // W1-ревью LOOP-6: нейтральный интент руки (browser_act{hover|scroll_to}) — тоже по сигнатуре цели: 12 прокруток к
  // РАЗНЫМ полям формы — не топтание (иначе L-1 возвращался через scroll_to), повтор той же цели — считается.
  if (eff !== "verify" && isBlindMutate(tu.name)) {
    if (eff === "mutate") {
      if (!r.isError) st.nudge.handActedSinceLook = true;
      // Эффект руки подтверждён самим вызовом (readback поля, навигация) — это не топтание: не считаем. Сброс ВСЕХ
      // счётчиков он не делает: иначе пинг-понг «слабый клик X / set Y с readback» обнулял бы счёт X каждым Y.
      if (!r.isError && r.observed === true) return;
    }
    const sig = handSignature(tu.name, tu.input);
    if (!st.nudge.seenHandSigs.has(sig)) {
      st.nudge.seenHandSigs.add(sig);
      return;
    }
  }
  bump(st, tu.name);
}
