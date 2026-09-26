/**
 * Стенд: ОДНА долгоживущая bench-сессия (dev: clientVersion "bench" → изоляция T-F1 — своя память, задачи `dev`,
 * без самообучения). Долгоживущая, потому что состояние браузерной руки (ref-подсказки, цель вкладки, одобрения
 * LMS) хранится в WeakMap по объекту сессии — новая сессия на каждый вызов его бы теряла.
 *
 * Сессия заводится через НАСТОЯЩИЙ реестр и makeSessionContext (как doHandshake), мозг по умолчанию — сценарный
 * стаб (реальный brain.llm из bench-сессии недостижим), кэш ответов выключен (детерминизм). Вызовы стенда
 * сериализуются мьютексом; политика §14-ответов вызова живёт в AsyncLocalStorage (см. bench-socket).
 */
import { AsyncMutex, type Logger } from "@jarvis/shared";
import { isActiveState } from "../../brain/tasks/task.js";
import type { Task } from "../../brain/tasks/task.js";
import { loadProfile } from "../../brain/profile.js";
import { DEV_USER, resolveAndProvision } from "../identity.js";
import type { SessionRegistry } from "../registry.js";
import { type BrainProviders, type SessionContext, type VoiceProviders, makeSessionContext } from "../router-ws.js";
import { type BenchCall, BenchSocket, benchCall } from "./bench-socket.js";
import { ScriptedLlm } from "./scripted-llm.js";

export interface BenchHubDeps {
  registry: SessionRegistry;
  providers: VoiceProviders;
  brain: BrainProviders;
  log: Logger;
  /** Тестам: свой userId без БД. По умолчанию — dev-резолв («bench» → DEV_USER). */
  resolveUser?: () => Promise<string>;
}

const BUSY_WAIT_MS = 5_000;
const INSPECTS_KEPT = 8;

export class BenchHub {
  private ctxP?: Promise<SessionContext>;
  private sock?: BenchSocket;
  private readonly mutex = new AsyncMutex();
  busy = false;
  /** Тексты последних снимков browser_inspect, свежий первым (для $ref в /dev/bench/tool), и последний результат. */
  inspectTexts: string[] = [];
  lastResultText = "";

  constructor(readonly deps: BenchHubDeps) {}

  ctx(): Promise<SessionContext> {
    if (!this.ctxP) this.ctxP = this.create().catch((e: unknown) => ((this.ctxP = undefined), Promise.reject(e)));
    return this.ctxP;
  }

  private async create(): Promise<SessionContext> {
    const { registry, providers, brain } = this.deps;
    const userId = this.deps.resolveUser ? await this.deps.resolveUser() : ((await resolveAndProvision("bench")) ?? DEV_USER);
    await Promise.all([loadProfile(userId), brain.spend.hydrate(userId)]);
    const sock = new BenchSocket();
    const { session } = registry.createOrResume(userId, sock);
    sock.bind(session);
    const ctx = makeSessionContext(session, { notePong() {}, stop() {} }, providers, brain, "bench");
    ctx.agentDeps.llm = new ScriptedLlm([]);
    ctx.agentDeps.responseCache = undefined;
    this.sock = sock;
    this.deps.log.info("bench-сессия поднята", { sessionId: session.sessionId, userId });
    return ctx;
  }

  /** Исполнить вызов стенда под мьютексом и политикой §14-ответов. Занято дольше 5 с → "busy". */
  async run<T>(call: BenchCall, fn: () => Promise<T>): Promise<T | "busy"> {
    if (!(await this.mutex.acquireWithTimeout(BUSY_WAIT_MS))) return "busy";
    this.busy = true;
    call.startedAt = Date.now();
    try {
      return await benchCall.run(call, fn);
    } finally {
      call.done = true;
      this.busy = false;
      this.mutex.release();
    }
  }

  /** Активные задачи ЭТОЙ сессии (включая разговорные). */
  activeTasks(ctx: SessionContext): Task[] {
    return this.deps.brain.tasks.list(ctx.session.userId).filter((t) => t.sessionId === ctx.session.sessionId && isActiveState(t.state));
  }

  /** Последняя задача сессии, начатая не раньше `since`. */
  lastTask(ctx: SessionContext, since: number): Task | undefined {
    return this.deps.brain.tasks.list(ctx.session.userId).find((t) => t.sessionId === ctx.session.sessionId && t.startedAt >= since);
  }

  /** Дождаться, пока у сессии нет фоновых задач и активных §20-задач. false — не дождались. */
  async waitIdle(ctx: SessionContext, ms: number): Promise<boolean> {
    const until = Date.now() + Math.max(0, ms);
    const idle = (): boolean => (ctx.agentDeps.bgTasks?.size ?? 0) === 0 && this.activeTasks(ctx).length === 0;
    while (!idle()) {
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  }

  noteInspect(text: string): void {
    this.inspectTexts = [text, ...this.inspectTexts].slice(0, INSPECTS_KEPT);
  }

  /** Снести bench-сессию (задачи отменяются teardown'ом сессии). Следующий вызов поднимет новую. */
  async reset(): Promise<{ removed: string | null; wasBusy: boolean }> {
    const wasBusy = this.busy;
    const p = this.ctxP;
    this.ctxP = undefined;
    this.inspectTexts = [];
    this.lastResultText = "";
    if (!p) return { removed: null, wasBusy };
    const ctx = await p.catch(() => undefined);
    if (!ctx) return { removed: null, wasBusy };
    ctx.voice.dispose();
    ctx.disposeAgent();
    this.deps.registry.remove(ctx.session.sessionId);
    this.sock?.close();
    this.sock = undefined;
    return { removed: ctx.session.sessionId, wasBusy };
  }

  /** §14-вопросы, пришедшие вне живого вызова (им ответили «нет»). */
  stray(): Array<{ kind: string; summary: string; at: number }> {
    return [...(this.sock?.stray ?? [])];
  }

  async state(): Promise<Record<string, unknown>> {
    const ctx = this.ctxP ? await this.ctxP.catch(() => undefined) : undefined;
    return {
      ext: { connected: this.deps.brain.extBridge.connected },
      session: ctx ? { id: ctx.session.sessionId, userId: ctx.session.userId, dev: ctx.agentDeps.devSession === true } : null,
      busy: this.busy,
      activeTasks: ctx ? this.activeTasks(ctx).map((t) => ({ taskId: t.taskId, state: t.state, title: t.title })) : [],
      stray: this.stray(),
    };
  }
}
