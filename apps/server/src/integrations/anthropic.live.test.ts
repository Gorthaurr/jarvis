/**
 * ЖИВОЙ тест токен-экономии prompt-кеша ПРЯМО против Anthropic (§15). Бьёт по реальному API,
 * читает usage.cache_read/cache_creation, доказывает цифрами:
 *   1) prompt-кеш реально работает (2-й идентичный префикс → cache_read, ~10× дешевле);
 *   2) ФИКС §8: блок навыка теперь кешируется СВОИМ брейкпоинтом (cache_read растёт на размер навыка);
 *   3) смена динамики (имя/контекст) НЕ ломает кеш персоны+навыка (динамика идёт ПОСЛЕ кешируемых).
 *
 * Gated: запускается ТОЛЬКО при RUN_LIVE_LLM=1 И наличии ANTHROPIC_API_KEY (тратит токены + сеть).
 * Запуск: RUN_LIVE_LLM=1 npx vitest run src/integrations/anthropic.live.test.ts (из apps/server).
 * Ключ берётся из process.env или из .env репозитория (секрет не печатается).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AnthropicLlmProvider } from "./anthropic.js";
import type { LlmRequest } from "./llm.js";

/** Подтянуть KEY=VALUE из первого найденного .env (секреты не логируем). */
function loadEnvFallback(keys: string[]): void {
  if (keys.every((k) => process.env[k])) return;
  for (const rel of [".env", "../.env", "../../.env", "../../../.env"]) {
    try {
      const raw = readFileSync(resolve(process.cwd(), rel), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
      }
      if (keys.some((k) => process.env[k])) return;
    } catch {
      /* нет файла — пробуем следующий */
    }
  }
}

loadEnvFallback(["ANTHROPIC_API_KEY"]);

const KEY = process.env.ANTHROPIC_API_KEY;
const RUN = process.env.RUN_LIVE_LLM === "1";
const MODEL = process.env.JARVIS_LIVE_TEST_MODEL || process.env.TIER1_MODEL || "claude-opus-4-8";
const d = KEY && RUN ? describe : describe.skip;

// Большой статический префикс — заведомо выше минимума кеширования (Opus/Haiku = 4096 ток.).
const PERSONA =
  "Ты — Джарвис, персональный ассистент-мажордом. Действуй вежливо, кратко и по делу. " +
  "Соблюдай правила и инструкции пользователя без отклонений. ".repeat(400);
// Блок «выученного навыка» — измеримого размера, чтобы увидеть прирост cache_read после фикса.
const SKILL =
  "# Подходящий выученный навык\n\nПроцедура: открыть отчёт, выгрузить в PDF, отправить в Telegram. " +
  "Шаг за шагом, аккуратно, проверяя каждый этап. ".repeat(40);

function req(extra: Partial<LlmRequest>): LlmRequest {
  return {
    tier: "fable",
    model: MODEL,
    systemStatic: PERSONA,
    messages: [{ role: "user", content: "Ответь одним словом: готов." }],
    maxTokens: 8,
    cachePrefix: true,
    ...extra,
  };
}

const fmt = (n: number): string => n.toLocaleString("ru-RU");

d(`LIVE Anthropic prompt-cache экономия (model=${MODEL})`, () => {
  const provider = new AnthropicLlmProvider({ apiKey: KEY, baseUrl: process.env.ANTHROPIC_BASE_URL, cacheTtl: "5m" });

  it("1) prompt-кеш РАБОТАЕТ: 2-й идентичный префикс читается из кеша (~10× дешевле)", async () => {
    const r1 = await provider.complete(req({}));
    const r2 = await provider.complete(req({})); // тот же префикс → должен попасть в кеш
    expect(r1.stubbed, "ожидался живой ответ Anthropic (проверь ключ/сеть)").toBe(false);
    expect(r2.stubbed).toBe(false);
    const u1 = r1.usage;
    const u2 = r2.usage;
    const baseCost = u2.inputTokens + u2.cacheReadTokens + u2.cacheCreationTokens; // если бы платили input 1× за всё
    const realCost = u2.inputTokens * 1 + u2.cacheReadTokens * 0.1 + u2.cacheCreationTokens * 1.25;
    const savedPct = baseCost > 0 ? Math.round((1 - realCost / baseCost) * 100) : 0;
    // eslint-disable-next-line no-console
    console.log(
      `\n[CACHE] call1: input=${fmt(u1.inputTokens)} creation=${fmt(u1.cacheCreationTokens)} read=${fmt(u1.cacheReadTokens)}` +
        `\n[CACHE] call2: input=${fmt(u2.inputTokens)} creation=${fmt(u2.cacheCreationTokens)} read=${fmt(u2.cacheReadTokens)}` +
        `\n[CACHE] 2-й ход: «как-если-без-кеша»=${fmt(baseCost)} ток · реально(норм.ед)=${realCost.toFixed(0)} → экономия ~${savedPct}% на входе\n`,
    );
    expect(u2.cacheReadTokens, "2-й идентичный префикс обязан читаться из кеша").toBeGreaterThan(0);
    expect(u2.cacheReadTokens).toBeGreaterThan(u2.inputTokens); // кешируемая часть >> свежий ввод
  }, 90_000);

  it("2) ФИКС §8: блок навыка кешируется СВОИМ брейкпоинтом → cache_read РАСТЁТ на размер навыка", async () => {
    await provider.complete(req({})); // прогреть персону
    const personaOnly = await provider.complete(req({}));
    const withSkillA = await provider.complete(req({ systemSkill: SKILL })); // запись блока навыка
    const withSkillB = await provider.complete(req({ systemSkill: SKILL })); // тот же навык → из кеша
    for (const r of [personaOnly, withSkillA, withSkillB]) expect(r.stubbed).toBe(false);
    // eslint-disable-next-line no-console
    console.log(
      `\n[SKILL] персона-только read=${fmt(personaOnly.usage.cacheReadTokens)}` +
        `\n[SKILL] +навык ход1: read=${fmt(withSkillA.usage.cacheReadTokens)} creation=${fmt(withSkillA.usage.cacheCreationTokens)}` +
        `\n[SKILL] +навык ход2: read=${fmt(withSkillB.usage.cacheReadTokens)} (вырос на ~размер навыка vs персона-только)\n`,
    );
    // Главная проверка фикса: с навыком из кеша читается БОЛЬШЕ, чем без навыка
    // (значит блок навыка реально попал в кеш своим брейкпоинтом, а не шлётся заново).
    expect(withSkillB.usage.cacheReadTokens).toBeGreaterThan(personaOnly.usage.cacheReadTokens);
  }, 120_000);

  it("3) смена ДИНАМИКИ не ломает кеш персоны+навыка (динамика идёт после кешируемых блоков)", async () => {
    await provider.complete(req({ systemSkill: SKILL })); // прогреть персону+навык
    const dynA = await provider.complete(req({ systemSkill: SKILL, systemDynamic: "Пользователя зовут Антон." }));
    const dynB = await provider.complete(req({ systemSkill: SKILL, systemDynamic: "Контекст полностью другой: зовут Борис, говорить на вы." }));
    expect(dynA.stubbed).toBe(false);
    expect(dynB.stubbed).toBe(false);
    // eslint-disable-next-line no-console
    console.log(
      `\n[DYN] динамика A: read=${fmt(dynA.usage.cacheReadTokens)}` +
        `\n[DYN] динамика B (другая): read=${fmt(dynB.usage.cacheReadTokens)} — кеш персоны+навыка УЦЕЛЕЛ при смене контекста\n`,
    );
    // Несмотря на РАЗНУЮ динамику, кешируемый префикс (персона+навык) читается из кеша в обоих.
    expect(dynB.usage.cacheReadTokens).toBeGreaterThan(0);
    expect(dynB.usage.cacheReadTokens).toBeGreaterThanOrEqual(Math.floor(dynA.usage.cacheReadTokens * 0.9));
  }, 120_000);

  it("4) обрыв по max_tokens детектируется на РЕАЛЬНОМ API (основа докрутки длинного вывода)", async () => {
    const long = await provider.complete(
      req({ maxTokens: 16, messages: [{ role: "user", content: "Напиши пять развёрнутых абзацев про историю Рима." }] }),
    );
    const short = await provider.complete(req({ messages: [{ role: "user", content: "Ответь одним словом: да." }] }));
    expect(long.stubbed).toBe(false);
    // eslint-disable-next-line no-console
    console.log(
      `\n[MAXTOK] длинный запрос @max16: stop=${long.stopReason} out=${long.usage.outputTokens}` +
        `\n[MAXTOK] короткий запрос: stop=${short.stopReason} out=${short.usage.outputTokens} — обрыв ловится → петля докрутит\n`,
    );
    expect(long.stopReason).toBe("max_tokens"); // реальный Anthropic сигналит обрыв
    expect(long.usage.outputTokens).toBeLessThanOrEqual(24);
    expect(short.stopReason).toBe("end_turn"); // короткий — нормальное завершение
  }, 90_000);
});
