/**
 * Харнесс инструментов: НАСТОЯЩИЙ серверный `dispatchTool` (все гейты §0/§14/SSRF, фасады, разбор результата) над
 * FakeDesktop вместо клиента ПК. Агент зовёт `lab.call("fs_write", {...})` и видит ЧТО ПРОИЗОШЛО: результат для модели,
 * заданные владельцу вопросы, ушедшие клиенту команды и то, что они сделали с «ПК» (эффекты/снимок).
 *
 * Изоляция: свой каталог данных (isolation.ts), память в процессе, веб — из seed, DNS — таблица. Сеть/боевой Джарвис не трогаются.
 */
import "./isolation.js"; // ПЕРВЫМ: ремень безопасности на пути данных до загрузки серверного кода
import { canonicalToolCall } from "../../../packages/tools/src/index.js";
import { type ToolContext, type ToolResult, dispatchTool } from "../../../apps/server/src/brain/tools/dispatch.js";
import { serializeToolResult } from "../../../apps/server/src/gateway/bench/bench-result.js";
import { createFakeDesktop } from "../desktop/index.js";
import type { ConfirmPolicy, DesktopEffect, DesktopSeed, DesktopSnapshot, FakeDesktop } from "../lib/contracts.js";
import { type ActionRecord, createActionBridge } from "./action-bridge.js";
import { type AskedQuestion, createConfirmRecorder } from "./confirm-policy.js";
import { createLabDir } from "./isolation.js";
import { LabWebProvider } from "./lab-web.js";
import { createLabServices, labResolver } from "./lab-services.js";
import { NOT_VERIFIABLE_PREFIX, labLimit } from "./limits.js";

export interface ToolLabOptions {
  seed?: DesktopSeed;
  /** Готовый FakeDesktop (иначе создаётся из seed). */
  desktop?: FakeDesktop;
  /** Политика ответов на §14 по умолчанию. Без неё — "no": необратимое не выполняется само. */
  confirm?: ConfirmPolicy;
  /** Части ToolContext поверх лабораторных (мок ext, mcp, market, skills...). Передача снимает соответствующий лимит. */
  ctx?: Partial<ToolContext>;
  /** Переопределения DNS для суда навигации: хост → адреса. */
  dns?: Record<string, string[]>;
  /** Лабораторный потолок ожидания ответа FakeDesktop (мс). */
  actionTimeoutMs?: number;
  /** false — вызывать даже «не проверяемые» инструменты (на свой риск). По умолчанию true. */
  enforceLimits?: boolean;
  /** Не удалять каталог прогона при close() (для разбора руками). */
  keepDir?: boolean;
}

export interface ToolCallOutcome {
  tool: string;
  args: Record<string, unknown>;
  /** Сырой ToolResult диспетчера (флаги честности: sent/declined/uncertain/observed/...). */
  result: ToolResult;
  isError: boolean;
  /** Текст tool_result, каким его видит модель (картинки — только счётчиком в `result`). */
  text: string;
  flags: Record<string, boolean | string>;
  /** §14-вопросы, заданные владельцу, и что на них ответила политика. */
  asked: AskedQuestion[];
  /** ActionCommand, ушедшие «клиенту», и что он ответил. */
  actions: ActionRecord[];
  /** Эффекты на «ПК» за этот вызов. */
  effects: DesktopEffect[];
  /** Состояние «ПК» после вызова. */
  snapshot: DesktopSnapshot;
  ms: number;
  /** Задано — инструмент НЕ вызывался: лаборатория его не проверяет (причина здесь). */
  notVerifiable?: string;
}

export interface ToolLab {
  readonly desktop: FakeDesktop;
  readonly ctx: ToolContext;
  readonly dir: string;
  readonly dataDir: string;
  readonly userId: string;
  call(tool: string, args?: Record<string, unknown>, opts?: { confirm?: ConfirmPolicy }): Promise<ToolCallOutcome>;
  /** Сбросить «ПК» (и веб) к seed; серверные сторы (память, напоминания) не трогаем. */
  reset(seed?: DesktopSeed): void;
  close(): Promise<void>;
}

export function createToolLab(opts: ToolLabOptions = {}): ToolLab {
  const labDir = createLabDir();
  const desktop = opts.desktop ?? createFakeDesktop(opts.seed);
  const bridge = createActionBridge(desktop, opts.actionTimeoutMs !== undefined ? { labTimeoutMs: opts.actionTimeoutMs } : {});
  const recorder = createConfirmRecorder(opts.confirm ?? "no");
  const web = new LabWebProvider(opts.seed?.web);
  const services = createLabServices(labDir.dataDir);
  const userId = `lab-${Math.random().toString(36).slice(2, 10)}`;

  const ctx = {
    session: { sendAction: bridge.sendAction },
    web,
    resolveHost: labResolver(opts.dns),
    episodic: services.episodic,
    userId,
    sessionId: "lab-session",
    origin: "user" as const,
    devSession: false, // dev-сессия молча пропускает memory_write/skill_save — проверяли бы пропуск, а не инструмент
    confirm: recorder.confirm,
    toolActivation: new Set<string>(),
    dynamicTools: services.dynamicTools,
    reminders: services.reminders,
    watch: services.watch,
    obligations: services.obligations,
    ...opts.ctx,
  } as ToolContext;

  return {
    desktop,
    ctx,
    dir: labDir.dir,
    dataDir: labDir.dataDir,
    userId,
    async call(tool, args = {}, o = {}) {
      recorder.reset(o.confirm ?? opts.confirm ?? "no");
      bridge.reset();
      const t0 = Date.now();
      const canonical = canonicalToolCall(tool, args).name;
      const limit = opts.enforceLimits === false ? null : (labLimit(tool, args, ctx) ?? labLimit(canonical, args, ctx));
      const result: ToolResult = limit
        ? { content: `${NOT_VERIFIABLE_PREFIX}: ${limit}`, isError: true }
        : await dispatchTool(tool, args, ctx);
      const ser = serializeToolResult(result);
      return {
        tool,
        args,
        result,
        isError: ser.isError,
        text: ser.text,
        flags: ser.flags,
        asked: recorder.asked(),
        actions: bridge.records(),
        effects: bridge.effects(),
        snapshot: desktop.snapshot(),
        ms: Date.now() - t0,
        ...(limit ? { notVerifiable: limit } : {}),
      };
    },
    reset(seed) {
      desktop.reset(seed);
      web.set(seed?.web ?? {});
      bridge.reset();
    },
    async close() {
      // Серверные хендлеры пишут «в фоне» (профиль/провенанс) уже ПОСЛЕ ответа — даём им дописать до удаления каталога.
      await new Promise((r) => setTimeout(r, 60));
      services.stop();
      bridge.dispose();
      if (opts.keepDir) labDir.release();
      else labDir.remove();
    },
  };
}
