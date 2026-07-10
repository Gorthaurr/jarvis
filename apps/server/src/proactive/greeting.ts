/**
 * Контекстное приветствие сессии (§9/§11) — «живое присутствие».
 *
 * Вместо канонной строки: учитываем ВРЕМЯ СУТОК и ПАМЯТЬ (имя, факты, недавние темы) →
 * короткий живой опенер, при уместности с проактивным вопросом. Это и есть «помнит контекст
 * между сессиями». Best-effort: нет имени/ключа/таймаут → детерминированный фолбэк (мгновенно).
 */
import type { Tier } from "@jarvis/shared";
import type { ILlmProvider } from "../integrations/llm.js";
import type { EpisodicMemory } from "../memory/episodic.js";

export interface GreetingDeps {
  llm: ILlmProvider;
  episodic: EpisodicMemory;
  models: Record<Exclude<Tier, "tier0">, string>;
}

/** Что Джарвис знает о пользователе (инъекция из профиля — без глобального состояния). */
export interface GreetingWho {
  name?: string;
  facts?: readonly string[];
}

/** Часть суток для приветствия (по локальному времени сервера). */
export function timeOfDay(d: Date = new Date()): string {
  const h = d.getHours();
  if (h < 5) return "Доброй ночи";
  if (h < 12) return "Доброе утро";
  if (h < 18) return "Добрый день";
  return "Добрый вечер";
}

/** Промис под мягким таймаутом: контекст приветствия НЕОБЯЗАТЕЛЕН, не задерживаем онбординг. */
function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      if (typeof t === "object" && "unref" in t) (t as { unref?: () => void }).unref?.();
    }),
  ]);
}

/**
 * Собрать приветствие. Без имени — онбординг (спрашиваем обращение), без LLM. Иначе, если есть
 * живой мозг — короткий контекстный опенер (haiku) с учётом времени, фактов и недавней памяти;
 * любой сбой/таймаут → детерминированный фолбэк по времени суток и имени.
 */
export async function buildGreeting(deps: GreetingDeps, userId: string, who: GreetingWho): Promise<string> {
  const name = who.name;
  const tod = timeOfDay();
  // Обращение дворецкого — «сэр», НЕ по имени (имя знаем для узнавания, не для оклика). Онбординг без имени.
  const fallback = name
    ? `${tod}, сэр. Джарвис к вашим услугам.`
    : `${tod}. Джарвис к вашим услугам. Как мне к вам обращаться?`;
  if (!name || !deps.llm.live) return fallback;

  try {
    const facts = (who.facts ?? []).slice(0, 8);
    // НЕ тянем сюда «недавние эпизоды» векторным поиском: это вытаскивало случайный/мусорный
    // контекст (авто-залогированные реплики, мисс-транскрипты) и Джарвис «вспоминал» на старте
    // то, чего пользователь не говорил. На старте — чисто. Проактивный повод — ТОЛЬКО из
    // курируемых фактов профиля (образ жизни, который Джарвис осознанно сохранил), не из сырых событий.
    const sys =
      "Ты — Джарвис, лаконичный голосовой дворецкий. Поздоровайся ОДНОЙ короткой живой фразой " +
      "(до 14 слов), по-русски, на «вы», с учётом времени суток. Обращение — «сэр» либо без обращения; " +
      "по ИМЕНИ хозяина НЕ называй (это рушит образ дворецкого). Если среди известных фактов есть " +
      "что-то уместное к этому времени — можешь ненавязчиво это учесть. НИЧЕГО не выдумывай и не " +
      "«вспоминай» того, чего нет в фактах. Без markdown, без воды, без перечислений.";
    const ctx =
      `Время суток: ${tod}.` +
      (facts.length ? ` Известные факты о пользователе: ${facts.join("; ")}.` : "");
    const resp = await raceTimeout(
      deps.llm.complete({
        tier: "haiku",
        model: deps.models.haiku,
        systemStatic: sys,
        messages: [{ role: "user", content: ctx }],
      }),
      2800,
    );
    return resp.text.trim() || fallback;
  } catch {
    return fallback;
  }
}
