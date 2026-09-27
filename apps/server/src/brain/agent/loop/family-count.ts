// W1 (L-1, L-12): учёт СЕМЕЙНОГО anti-runaway по каждому вызову раунда (сам порог и нудж — anti-runaway.ts familyCap).
// Было: счёт по сырому ИМЕНИ за задачу — 14 разных browser_act-кликов давали на 6-м нудж «топтание», на 12-м обрыв
// «Застрял на browser_act»: тест в Moodle / форма из ≥12 полей были физически невозможны, хотя персона сама велит серию.
// Стало:
//  • РУКИ (слепые mutate) — по СИГНАТУРЕ цели (имя + вход без значения поля): первая встреча цели бесплатна, повтор
//    считается. Долбёжка одной кнопки (даже вперемешку с другими действиями) по-прежнему упирается в кап; подряд
//    одинаковые раунды по-прежнему ловит antiRunawayIdentical.
//  • Рука с ПОДТВЕРЖДЁННЫМ эффектом (observed — readback поля/навигация) не считается вовсе: это не топтание.
//  • ПРОГРЕСС обнуляет счётчики рук и глаз: взгляд, увидевший ПОСЛЕ действия руки НОВОЕ состояние (нормализованный
//    текст, см. lookDigest). Новая страница = новые цели, а ref на ней могут совпасть со старыми (реестр расширения
//    живёт в документе). ТОТ ЖЕ ВИД = тот же нормализованный текст И между взглядами не было руки по НОВОЙ цели —
//    такой взгляд считается (топтание), иначе — нет (W1-ревью р2: скрин после каждой из 13 разных рук в UIA-слепом окне
//    — не топтание, а у скрина текст — постоянный маркер; прогресс картинки без текста — только новая цель руки).
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
/**
 * Хеш ТЕКСТОВОЙ сути взгляда (W1-ревью LOOP-1, р2 loop-tests-2). Картинка (base64 кадра) другая на каждом кадре — в хеш
 * не входит. Числа на живой странице тикают сами (позиция плеера, таймер попытки Moodle, часы, «N минут назад», value
 * ползунка) — общий принцип вместо денилиста источников: цифровые прогоны → «#», пробелы схлопнуты, ref-токены убраны.
 * Цена: страницы, различающиеся ТОЛЬКО числами, — «тот же вид» (как тикающий счётчик); рука по новой цели это покрывает.
 */
function lookDigest(content: ToolResult["content"]): string {
  const text = typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  const norm = text.replace(REF_TOKEN, "ref").replace(/\d+/gu, "#").replace(/\s+/gu, " ").trim();
  return createHash("sha1").update(norm).digest("hex");
}

/**
 * Взгляд увидел НЕ тот же вид (и потому не считается)? Новый текст после действия руки — прогресс страницы: счётчики
 * рук и глаз с нуля. Рука по НОВОЙ цели без смены текста — взгляд не считается, но счёт рук идёт дальше: долбёжка
 * одной цели со скрином после каждого клика по-прежнему ловится (её сигнатура уже видена — «новой руки» нет).
 */
function lookSeesNewView(st: LoopState, name: string, content: ToolResult["content"]): boolean {
  const n = st.nudge;
  const digest = lookDigest(content);
  const prev = n.lookDigests.get(name);
  n.lookDigests.set(name, digest);
  const pageChanged = n.handActedSinceLook && prev !== undefined && prev !== digest;
  const newTarget = n.newHandSinceLook;
  n.handActedSinceLook = false;
  n.newHandSinceLook = false;
  if (pageChanged) resetPageFamily(st);
  return pageChanged || newTarget;
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
  if (eff === "verify" && !r.isError && r.empty !== true && lookSeesNewView(st, tu.name, r.content)) return;
  // W1-ревью LOOP-6: нейтральный интент руки (browser_act{hover|scroll_to}) — тоже по сигнатуре цели: 12 прокруток к
  // РАЗНЫМ полям формы — не топтание (иначе L-1 возвращался через scroll_to), повтор той же цели — считается.
  if (eff !== "verify" && isBlindMutate(tu.name)) {
    const sig = handSignature(tu.name, tu.input);
    const fresh = !st.nudge.seenHandSigs.has(sig);
    st.nudge.seenHandSigs.add(sig);
    if (eff === "mutate" && !r.isError) {
      st.nudge.handActedSinceLook = true;
      if (fresh) st.nudge.newHandSinceLook = true;
      // Эффект руки подтверждён самим вызовом (readback поля, навигация) — это не топтание: не считаем. Сброс ВСЕХ
      // счётчиков он не делает: иначе пинг-понг «слабый клик X / set Y с readback» обнулял бы счёт X каждым Y. Цель
      // при этом запомнена: повтор Y со скрином после каждого — уже не «новая рука» (взгляд считается).
      if (r.observed === true) return;
    }
    if (fresh) return;
  }
  bump(st, tu.name);
}
