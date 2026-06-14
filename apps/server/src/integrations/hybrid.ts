/**
 * Гибридный LLM-провайдер (§7): основной (Anthropic/Opus через шлюз) + резерв (Ollama).
 *
 * Circuit breaker: пока основной отвечает — используем его (качество Opus). Как только
 * он падает (сетевой сбой шлюза → stub) — открываем брейкер на cooldown и идём в
 * локальную Ollama (честный Джарвис, без задержек). По истечении cooldown снова
 * пробуем основной — авто-возврат на Opus, когда шлюз/ключ оживут. Реализует ILlmProvider.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import type { ILlmProvider, LlmRequest, LlmResponse } from "./llm.js";

export interface HybridConfig {
  /** На сколько «выключать» основной после сбоя, прежде чем пробовать снова. */
  cooldownMs?: number;
  now?: () => number;
  log?: Logger;
}

export class HybridLlmProvider implements ILlmProvider {
  readonly live: boolean;
  private downUntil = 0;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(
    private readonly primary: ILlmProvider,
    private readonly fallback: ILlmProvider,
    cfg: HybridConfig = {},
  ) {
    this.cooldownMs = cfg.cooldownMs ?? 60_000;
    this.now = cfg.now ?? (() => Date.now());
    this.log = cfg.log ?? createLogger("llm:hybrid");
    this.live = primary.live || fallback.live;
    this.log.info("гибрид LLM", { primaryLive: primary.live, fallbackLive: fallback.live });
  }

  private primaryHealthy(): boolean {
    return this.primary.live && this.now() >= this.downUntil;
  }

  private tripBreaker(reason: string): void {
    const wasUp = this.now() >= this.downUntil;
    this.downUntil = this.now() + this.cooldownMs;
    if (wasUp) this.log.warn("основной LLM недоступен → резерв (Ollama)", { reason, cooldownMs: this.cooldownMs });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (this.primaryHealthy()) {
      try {
        const r = await this.primary.complete(req);
        if (!r.stubbed) return r; // основной ответил — отлично (Opus)
        this.tripBreaker("primary stubbed"); // внутренний сбой основного (шлюз/ключ)
      } catch (e) {
        this.tripBreaker(e instanceof Error ? e.message : String(e));
      }
    }
    return this.fallback.complete(req);
  }

  /**
   * Стартовая проба основного: если лежит — заранее открыть брейкер, чтобы ПЕРВАЯ
   * реплика пользователя сразу шла в Ollama (без медленного таймаута на мёртвый шлюз).
   * Fire-and-forget из gateway на старте.
   */
  async probePrimary(model: string): Promise<void> {
    if (!this.primary.live) return;
    try {
      const r = await this.primary.complete({
        tier: "haiku",
        model,
        systemStatic: "ping",
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 8,
      });
      if (r.stubbed) this.tripBreaker("проба: основной недоступен");
      else this.log.info("основной LLM доступен (Opus)");
    } catch (e) {
      this.tripBreaker(e instanceof Error ? e.message : String(e));
    }
  }
}
