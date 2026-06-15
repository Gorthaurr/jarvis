/**
 * Дворецкие подтверждения «принял задачу, приступаю» (§11, §20).
 *
 * Мгновенный отзыв перед фоновой работой. Голос — персоны (а не зашитый список),
 * но мгновенность ack сохраняется: пул фраз генерит LLM ОДИН раз в фоне (warm),
 * а pick() всегда отдаёт из готового пула без обращения к модели. До прогрева и
 * при любом сбое генерации — детерминированный seed (он же используется в тестах).
 *
 * Ротация НЕ хранится здесь (нет процесс-глобального счётчика): pick(rotation)
 * чист, счётчик держит сессия — так ротация per-session и тестируема.
 */
import type { ILlmProvider } from "../../integrations/llm.js";

/** Сид-фразы: фоллбэк до прогрева и при сбое LLM (детерминированы для тестов). */
export const DEFAULT_BUTLER_ACKS: readonly string[] = [
  "Слушаюсь, сэр.",
  "Сию минуту, сэр.",
  "Уже занимаюсь, сэр.",
  "Будет сделано, сэр.",
  "Принято, сэр.",
];

/** Зависимости генерации пула (тир/модель/персона для голоса). */
export interface AckGenDeps {
  llm: ILlmProvider;
  /** id модели дешёвого тира (haiku) — генерация фраз дёшева. */
  model: string;
  /** Системный префикс персоны — чтобы фразы звучали голосом Джарвиса. */
  persona: string;
}

/**
 * Пул дворецких подтверждений. Один на gateway (генерация — общая, не на сессию),
 * ротация — снаружи (per-session счётчик).
 */
export class ButlerAcks {
  private pool: string[];
  private warmed = false;
  private warming: Promise<void> | null = null;

  constructor(
    private readonly gen?: AckGenDeps,
    seed: readonly string[] = DEFAULT_BUTLER_ACKS,
  ) {
    this.pool = [...seed];
  }

  /** Готов ли LLM-пул (для диагностики/тестов). */
  get isWarm(): boolean {
    return this.warmed;
  }

  /** Текущие фразы (для тестов/диагностики). */
  phrases(): readonly string[] {
    return this.pool;
  }

  /**
   * Прогреть пул через LLM (фоном, идемпотентно). Любой сбой/пустой результат —
   * оставляем seed. Безопасно звать на старте: не блокирует и не бросает.
   */
  warm(count = 8): Promise<void> {
    if (this.warmed || !this.gen) return Promise.resolve();
    if (this.warming) return this.warming;
    this.warming = this.generate(count)
      .then((phrases) => {
        if (phrases.length >= 3) {
          this.pool = phrases;
          this.warmed = true;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.warming = null;
      });
    return this.warming;
  }

  /**
   * Мгновенное подтверждение из пула с ротацией по переданному счётчику. Счётчик
   * держит вызывающий (сессия) — здесь состояния нет.
   */
  pick(rotation: number): string {
    const src = this.pool.length > 0 ? this.pool : DEFAULT_BUTLER_ACKS;
    const len = src.length;
    const i = ((Math.trunc(rotation) % len) + len) % len;
    return src[i] ?? DEFAULT_BUTLER_ACKS[0]!;
  }

  private async generate(count: number): Promise<string[]> {
    const gen = this.gen!;
    const resp = await gen.llm.complete({
      tier: "haiku",
      model: gen.model,
      systemStatic: gen.persona,
      messages: [
        {
          role: "user",
          content:
            `Сгенерируй ${count} коротких подтверждений в духе «принял, приступаю» — твоим голосом, ` +
            `по-дворецки, с обращением «сэр». Каждое 2–4 слова. Только список: по одному в строке, ` +
            `без нумерации и пояснений.`,
        },
      ],
      cachePrefix: false,
      maxTokens: 200,
      temperature: 1,
    });
    return parseAckLines(resp.text);
  }
}

/** Разобрать ответ модели в список фраз: чистка маркеров/нумерации/кавычек, отсев мусора. */
export function parseAckLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, "")
      .replace(/^["'«»`]+|["'«»`]+$/gu, "")
      .trim();
    if (line.length === 0 || line.length > 40) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}
