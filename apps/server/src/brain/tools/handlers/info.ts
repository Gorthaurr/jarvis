/**
 * Хендлеры ИНФО-доменов (§) — вынесено из god-object dispatch.ts (§ревью).
 * web_search/web_fetch (веб), knowledge_consult (база знаний), memory_search (эпизодическая память).
 * Результаты внешних источников — `untrusted()` (граница данные/инструкции). Маршрутизация — в dispatch (switch).
 */
import { metrics } from "../../../obs/metrics.js";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { err, numField, ok, untrusted } from "../dispatch-util.js";

export async function webSearch(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const q = String(input.query ?? "").trim();
  if (!q) return err("web_search: пустой query");
  // Схема инструмента (§12) объявляет поле `count`; принимаем и `limit` для совместимости.
  const limit = numField(input, ["count", "limit"], 5);
  const hits = await ctx.web.search(q, limit);
  if (hits.length === 0) {
    // Скрытая деградация (пункт-6): поиск отработал без ошибки, но пусто → durable-сигнал для «почему недоработал».
    metrics.recordDegradation("web_search_empty", { query: q.slice(0, 120), ...(ctx.userId ? { userId: ctx.userId } : {}) });
    return ok("Ничего не найдено (или web-провайдер в стаб-режиме).");
  }
  return untrusted("веб-поиск", hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n"));
}

export async function webFetch(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const url = String(input.url ?? "").trim();
  if (!url) return err("web_fetch: пустой url");
  const page = await ctx.web.fetch(url);
  if (!page) return err("Не удалось загрузить страницу.");
  // Схема инструмента (§12) объявляет maxChars — honor'им, если задан.
  const max = numField(input, ["maxChars"], 0);
  const text = max > 0 ? page.text.slice(0, max) : page.text;
  return untrusted(`веб-страница ${url}`, `# ${page.title}\n${text}`);
}

export async function knowledgeConsult(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.knowledge) return err("База знаний недоступна (не сконфигурирована).");
  const domain = String(input.domain ?? "").trim().toLowerCase();
  const query = String(input.query ?? "").trim();
  if (!domain) return err(`knowledge_consult: укажи domain. Доступно: ${ctx.knowledge.domains().join(", ") || "—"}.`);
  const r = ctx.knowledge.consult(domain, query);
  if (!r.found) return err(`Нет домена «${domain}». Доступно: ${ctx.knowledge.domains().join(", ") || "—"}.`);
  // ЧЕСТНЫЙ ПРОМАХ (аудит контекста 2026-07-20): раздел под запрос не нашёлся — НЕ выдаём intro за
  // состоявшуюся консультацию (мнимое грундирование опаснее его отсутствия). Прямо говорим «нет раздела»
  // + оглавление для уточнения. Это НАШ статус (не внешние данные) → ok(), без untrusted-обёртки.
  if (!r.matched) {
    // Скрытая деградация (пункт-6): консультация без совпадения раздела — durable-сигнал (мнимое грундирование
    // опаснее его отсутствия; здесь фиксируем, что эксперт НЕ свериался с релевантным разделом).
    metrics.recordDegradation("knowledge_miss", { domain, query: query.slice(0, 120), ...(ctx.userId ? { userId: ctx.userId } : {}) });
    return ok(
      `В базе знаний «${domain}» нет раздела под запрос «${query}». Разделы: ${r.topics.join(" · ") || "—"}. ` +
        `Уточни запрос словами из разделов ИЛИ действуй по общим принципам (при нужде — web_search свежих источников).`,
    );
  }
  // Знание — ДАННЫЕ для рассуждения (не команды): помечаем как недоверенный контент (§безопасность).
  return untrusted(`база знаний: ${domain}`, `${r.text}\n\n[разделы: ${r.topics.join(" · ")}]`);
}

export async function memorySearch(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const q = String(input.query ?? "").trim();
  if (!q) return err("memory_search: пустой query");
  // Схема инструмента (§8) объявляет `topK`; принимаем и `k` для совместимости. Клампим к целому
  // 1..50: значение приходит от LLM, дробное/отрицательное роняет SQL LIMIT → тихий пустой результат.
  const k = Math.max(1, Math.min(50, Math.floor(numField(input, ["topK", "k"], 5))));
  // Аудит контекста 2026-07-20: ЯВНЫЙ поиск — БЕЗ порога авто-ретривала (memoryMinScore). Модель сама
  // запросила и ВИДИТ score у каждого хита → судит по нему; над-фильтровать deliberate-probe (спрятать
  // 0.8-хит, который модель искала) хуже, чем показать со счётом. Порог 0.82 — только для НЕзапрошенной
  // авто-инъекции в доверенный промпт (там сосед читался бы как факт). Здесь показываем всё со score.
  const hits = await ctx.episodic.search(ctx.userId, q, k, 0);
  if (hits.length === 0) return ok("В памяти ничего релевантного не найдено.");
  return ok(hits.map((h) => `- ${h.episode.text} (${h.score.toFixed(2)})`).join("\n"));
}
