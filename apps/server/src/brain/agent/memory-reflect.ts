/**
 * Рефлекс-бэкстоп памяти (§8, ревью памяти 2026-07-10, А3) — зеркало selfLearnSkill для ФАКТОВ.
 *
 * Диагноз ревью: `memory_write` не вызывался НИ РАЗУ за 15 дней (facts: 0) — у процедур есть
 * авто-петля самообучения (29 навыков), у фактов о владельце не было ничего. Здесь: реплика с
 * МАРКЕРОМ устойчивого факта («я всегда…», «мой брат…», «у меня аллергия…») → ОДИН рефлексивный
 * вызов на дешёвом тире с узким набором [memory_write] и строгим анти-мусорным промптом
 * («обычно фактов НЕТ»). Fire-and-forget: голосовой ход не ждёт.
 *
 * Анти-спам: (1) грубый префильтр-маркер (LLM зовётся редко), (2) суточный кап
 * JARVIS_MEMORY_REFLECT_CAP (деф 8), (3) семантический дедуп внутри writeUserMemory,
 * (4) кап 20 фактов в профиле. Выключатель: JARVIS_MEMORY_REFLECT=0.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { TOOLS_BY_NAME } from "@jarvis/tools";
import type { ILlmProvider } from "../../integrations/llm.js";
import type { EpisodicMemory } from "../../memory/episodic.js";
import { writeUserMemory } from "../../memory/user-memory.js";
import { costUsd } from "../../obs/pricing.js";
import type { SpendGuard } from "../../billing/index.js";

const log: Logger = createLogger("memory-reflect");

/**
 * Маркеры УСТОЙЧИВОГО факта о пользователе/его мире. Узко и в первом лице: одноразовые команды
 * («сделай», «открой») сюда не попадают. «запомни» НЕ включаем — явную просьбу модель обслуживает
 * сама через memory_write (персона v71), бэкстоп ловит именно НЕявные заявления.
 */
const FACT_MARKER_RE =
  /(?:^|[\s,])(?:я\s+(?:всегда|обычно|часто|редко|никогда|люблю|не\s+люблю|ненавижу|обожаю|предпочитаю|работаю|играю|тренируюсь|занимаюсь|встаю|ложусь|живу|учусь)|у\s+меня\s+(?:есть|нет|аллергия)|мо[йяё]\s+(?:жена|муж|брат|сестра|мама|папа|сын|дочь|кот|кошка|собака|машина|график|распорядок|день\s+рождения)|мне\s+(?:нравится|не\s+нравится))(?=[\s,.!?]|$)/iu;

/** Есть ли в реплике маркер устойчивого факта (дешёвый префильтр перед LLM-рефлексией). */
export function hasStableFactMarker(text: string): boolean {
  return FACT_MARKER_RE.test(text);
}

const SYSTEM_PROMPT =
  "Ты — модуль памяти голосового ассистента. Дана одна реплика пользователя (сырой STT-текст). " +
  "Если в ней есть УСТОЙЧИВЫЙ факт о пользователе или его мире (привычка, предпочтение, родня, " +
  "аллергия, график, образ жизни) — вызови memory_write ОДИН раз с коротким фактом в третьем лице " +
  "(«Работает по ночам», «Брат — Женя»; kind: preference для вкусов, fact для остального). " +
  "Лакмус: будет ли это правдой и пользой через месяц? Одноразовые команды, сиюминутное состояние, " +
  "вопросы, игровой трёп и STT-шум — НЕ факты: тогда НЕ вызывай инструмент и ответь пустой строкой. " +
  "Чаще всего факта НЕТ.";

/** Суточный кап рефлексий per-user (не окно — календарный день; сброс на смене дня). */
const dayCounters = new Map<string, { day: string; count: number }>();

function underDailyCap(userId: string): boolean {
  const cap = (() => {
    const n = Number.parseInt(process.env.JARVIS_MEMORY_REFLECT_CAP ?? "", 10);
    return Number.isFinite(n) && n >= 0 ? n : 8;
  })();
  if (cap === 0) return false;
  const today = new Date().toISOString().slice(0, 10);
  const c = dayCounters.get(userId);
  if (!c || c.day !== today) {
    dayCounters.set(userId, { day: today, count: 0 });
    return true;
  }
  return c.count < cap;
}

function bumpDailyCap(userId: string): void {
  const c = dayCounters.get(userId);
  if (c) c.count += 1;
}

export interface MemoryReflectArgs {
  llm: ILlmProvider;
  /** Дешёвый тир (слабая модель): рефлексия — механика, не рассуждение. */
  model: string;
  episodic: EpisodicMemory;
  userId: string;
  /** Реплика пользователя (clean, после cleanDisfluency). */
  utterance: string;
  /** Гвард трат §14 (ревью: расход рефлексии обязан быть видим SpendGuard, как у selfLearnSkill). */
  spend?: SpendGuard;
}

/**
 * Рефлексия одной реплики → 0..1 факт в память. Вызывать fire-and-forget ТОЛЬКО после
 * hasStableFactMarker (иначе жжём вызовы на каждом ходе). Ошибки глотаются (бэкстоп не должен
 * ронять ход); суточный кап — внутри.
 */
export async function reflectFactFromUtterance(args: MemoryReflectArgs): Promise<void> {
  if (process.env.JARVIS_MEMORY_REFLECT === "0") return;
  if (!underDailyCap(args.userId)) return;
  bumpDailyCap(args.userId); // считаем ВЫЗОВ, не успех — кап ограничивает расход LLM
  const memWriteSchema = TOOLS_BY_NAME.memory_write;
  if (!memWriteSchema) return;
  // §14: расход рефлексии ВИДИМ SpendGuard'у (ревью 2026-07-10 — как у selfLearnSkill; месячный
  // потолок пользователя не обходится фоновыми вызовами).
  const reflectId = `memory-reflect:${args.userId}:${Date.now()}`;
  if (args.spend && !args.spend.check(reflectId, 0.01, 500).allowed) return;
  try {
    const resp = await args.llm.complete({
      tier: "sonnet",
      model: args.model,
      systemStatic: SYSTEM_PROMPT,
      messages: [{ role: "user", content: args.utterance }],
      tools: [memWriteSchema],
    });
    args.spend?.recordStep(reflectId);
    args.spend?.recordUsage(reflectId, resp.usage.inputTokens + resp.usage.outputTokens, costUsd(args.model, resp.usage));
    const tu = resp.toolUses.find((t) => t.name === "memory_write");
    if (!tu) return; // фактов нет — штатный (частый) исход
    const input = tu.input as { content?: unknown; text?: unknown; kind?: unknown };
    const text = String(input.content ?? input.text ?? "").trim();
    if (!text) return;
    const kind = input.kind === "preference" ? "preference" : "fact";
    const outcome = await writeUserMemory(args.episodic, args.userId, kind, text);
    log.info("рефлекс памяти: устойчивый факт из реплики", { outcome, preview: text.slice(0, 60) });
  } catch (e) {
    log.debug("рефлекс памяти пропущен", e instanceof Error ? e.message : String(e));
  } finally {
    args.spend?.finishTask(reflectId);
  }
}
