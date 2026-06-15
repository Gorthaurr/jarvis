/**
 * Сборка системного промпта (§11, §15).
 *
 * Статичный префикс (персона из persona.md) кешируется и не меняется между
 * запросами — это включает prompt caching на стороне Anthropic (§15): кешируемый
 * блок идёт первым, динамика пользователя — отдельным хвостом.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("persona");

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSONA_PATH = join(__dirname, "persona.md");

/** Кеш статичного префикса — читаем persona.md один раз на процесс. */
let cachedPersona: string | null = null;

/** Прочитать персону с диска (с фоллбэком, если файл не найден). */
function loadPersona(): string {
  if (cachedPersona !== null) return cachedPersona;
  try {
    cachedPersona = readFileSync(PERSONA_PATH, "utf8");
  } catch (e) {
    log.warn("persona.md не прочитан — используем минимальный фоллбэк", {
      error: e instanceof Error ? e.message : String(e),
    });
    cachedPersona = FALLBACK_PERSONA;
  }
  return cachedPersona;
}

/** Динамический контекст пользователя — подставляется в хвост промпта (§15). */
export interface UserContextSlot {
  /** Имя/обращение, как звать пользователя. */
  displayName?: string;
  /** Часовой пояс (для времени в ответах). */
  timezone?: string;
  /** Произвольные факты долговременной памяти (§8), уже отобранные retrieval'ом. */
  facts?: readonly string[];
  /** Авто-профиль окружения (§9): браузер/приложения пользователя — чтобы агент адаптировался. */
  environment?: string;
}

/**
 * Собрать системный промпт: [кешируемая персона] + [динамика пользователя].
 * Возвращает блоки раздельно, чтобы слой LLM-клиента мог пометить первый как
 * cache_control (§15). Для простоты M0 — также склеенная строка `full`.
 */
export function buildSystemPrompt(slot: UserContextSlot = {}): {
  staticPrefix: string;
  dynamicSuffix: string;
  full: string;
} {
  const staticPrefix = loadPersona();
  const dynamicSuffix = renderDynamic(slot);
  return {
    staticPrefix,
    dynamicSuffix,
    full: dynamicSuffix ? `${staticPrefix}\n\n${dynamicSuffix}` : staticPrefix,
  };
}

function renderDynamic(slot: UserContextSlot): string {
  const lines: string[] = [];
  if (slot.displayName) lines.push(`Пользователя зовут: ${slot.displayName}.`);
  if (slot.timezone) lines.push(`Часовой пояс пользователя: ${slot.timezone}.`);
  if (slot.environment) {
    // §9: окружение определено АВТОМАТИЧЕСКИ. Действуй под него: для веба используй
    // браузер пользователя, для задач — установленные у него приложения; не предполагай.
    lines.push(`Окружение (определено автоматически): ${slot.environment}`);
  }
  if (slot.facts && slot.facts.length > 0) {
    lines.push("Известные факты о пользователе:");
    for (const f of slot.facts) lines.push(`- ${f}`);
  }
  if (lines.length === 0) return "";
  return `# Контекст пользователя\n\n${lines.join("\n")}`;
}

const FALLBACK_PERSONA = [
  "Ты — Джарвис, лаконичный голосовой ассистент. Говоришь по-русски.",
  "Кратко, по делу, без подхалимства. Юмор сухой и только в безобидных темах —",
  "никогда в ошибках, деньгах и подтверждениях. Неуверенность называешь прямо.",
].join(" ");
