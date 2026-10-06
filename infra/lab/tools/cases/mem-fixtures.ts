/**
 * Общие моки и сид для кейсов mem-*.cases.ts (память, навыки, саморасширение, каналы программ, самоосмотр).
 * Кейс — данные, поэтому свежее состояние на каждый кейс дают геттеры: харнесс разворачивает `lab.ctx` spread'ом при
 * создании лаборатории, и геттер срабатывает раз на кейс (JARVIS_DATA_DIR к тому моменту уже кейсовый). Серверное
 * состояние проверяют предикаты (`state`/`effects` синхронны), поэтому нужное лежит в `cur`. userId у кейса свой
 * (`lab-m-<tag>`): профиль, память и навыки живут в глобальных кешах процесса.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { ActionResult } from "../../../../packages/protocol/src/index.js";
import { TOOLS_BY_NAME } from "../../../../packages/tools/src/index.js";
import { KnowledgeBase } from "../../../../apps/server/src/brain/knowledge/index.js";
import { getProfile } from "../../../../apps/server/src/brain/profile.js";
import { makeToolSetBuilder } from "../../../../apps/server/src/brain/agent/loop/tool-set.js";
import { DynamicToolStore } from "../../../../apps/server/src/brain/tools/dynamic.js";
import type { ToolContext } from "../../../../apps/server/src/brain/tools/dispatch.js";
import { HashEmbeddingProvider } from "../../../../apps/server/src/integrations/openai-embeddings.js";
import { resetAppRecipesForTest } from "../../../../apps/server/src/memory/app-recipes.js";
import { type Episode, InMemoryEpisodicMemory } from "../../../../apps/server/src/memory/episodic.js";
import { type SkillProvider, type SkillRecord, SHARED_USER_ID, createSkillProvider, getSkill, saveSkill, serializeLearnedSkill } from "../../../../apps/server/src/memory/skills.js";

/** Состояние ТЕКУЩЕГО кейса для предикатов (кейсы идут последовательно). */
export const cur: { spy?: SpyEpisodic; saved?: SkillRecord | null; shared?: SkillRecord | null; act?: Set<string>; dyn?: DynamicToolStore; sent: unknown[] } = { sent: [] };

export const uid = (tag: string): string => `lab-m-${tag}`;
export const is = (cond: boolean, why: string): true | string => cond || why;
export const all = (...c: Array<true | string>): true | string => c.find((x) => x !== true) ?? true;
export const factsOf = (tag: string): string[] => getProfile(uid(tag)).facts ?? [];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ctx кейса: `plain` — обычные поля, `lazy` — геттеры (получают userId), срабатывающие раз при создании лаборатории. */
export function lazyCtx(tag: string, lazy: Record<string, (user: string) => unknown> = {}, plain: Partial<ToolContext> = {}): Partial<ToolContext> {
  const o: Record<string, unknown> = { userId: uid(tag), ...plain };
  for (const [k, f] of Object.entries(lazy)) Object.defineProperty(o, k, { get: () => f(uid(tag)), enumerable: true, configurable: true });
  return o as Partial<ToolContext>;
}

// ───────────── память ─────────────

/** Эпизодика со шпионом: журнал записей, сид своих/чужих фактов (партиция) и пауза перед поиском (фон хука противоречий). */
export class SpyEpisodic extends InMemoryEpisodicMemory {
  writes: Array<Omit<Episode, "id">> = [];
  private ready: Promise<unknown>;
  constructor(seeds: ReadonlyArray<readonly [string, string]>, private settleMs: number) {
    super(new HashEmbeddingProvider());
    this.ready = Promise.all(seeds.map(([userId, text]) => super.write({ userId, kind: "fact", text, ts: 1 })));
  }
  override async write(e: Omit<Episode, "id">): Promise<void> {
    this.writes.push(e);
    return super.write(e);
  }
  override async search(...a: Parameters<InMemoryEpisodicMemory["search"]>): ReturnType<InMemoryEpisodicMemory["search"]> {
    await this.ready;
    if (this.settleMs) await sleep(this.settleMs);
    return super.search(...a);
  }
}
/** other — факты ДРУГОГО арендатора, own — уже лежащие у своего (минуя профиль), settleMs — ждать фон хука. */
export function spy(user: string, o: { other?: readonly string[]; own?: readonly string[]; settleMs?: number } = {}): SpyEpisodic {
  const seeds = [...(o.other ?? []).map((t) => ["lab-other-tenant", t] as const), ...(o.own ?? []).map((t) => [user, t] as const)];
  return (cur.spy = new SpyEpisodic(seeds, o.settleMs ?? 0));
}

/** Хук противоречий с заданным ответом «дешёвой модели»; stub — канал недоступен (это не «нет противоречий»). */
export const hookLlm = (text: string, stub = false): NonNullable<ToolContext["contradiction"]> =>
  ({ model: "lab", llm: { complete: async () => ({ text, toolUses: [], stubbed: stub, stopReason: stub ? "stub" : "end_turn" }) } }) as never;

// ───────────── навыки ─────────────

const stepsMd = (id: string, name: string, steps: string[]): string => `---\nid: ${id}\nname: ${name}\nversion: 1\n---\n\n## Шаги\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`;
/** Реплей-навык (записан показом): шаги строками вида `app.launch app="calc"`. */
export const replayMd = stepsMd;
/** Выученная процедура (как после skill_save), в т.ч. вредная — записанная мимо сканера. */
export const learnedMd = (id: string, name: string, procedure: string): string => serializeLearnedSkill({ id, name, version: 1, when: "по просьбе", procedure });

/** Настоящий провайдер навыков (скан, карантин, дедуп, promote) над памятью процесса + сид + захват записанного для предикатов. */
export function skillsKit(user: string, seed: string[] = []): SkillProvider {
  const real = createSkillProvider();
  cur.saved = cur.shared = undefined;
  const ready = Promise.all(seed.map((md) => saveSkill(user, md)));
  return {
    list: async (id) => (await ready, real.list(id)),
    get: async (id, sid) => (await ready, real.get(id, sid)),
    recall: async (id, text) => (await ready, real.recall(id, text)),
    async save(id, input) {
      await ready;
      const r = await real.save(id, input);
      cur.saved = r && "id" in r ? await getSkill(id, r.id) : null;
      return r;
    },
    async promote(id, sid) {
      await ready;
      const r = await real.promote!(id, sid);
      cur.shared = await getSkill(SHARED_USER_ID, sid);
      return r;
    },
  };
}

// ───────────── клиент: code.run и сбои канала ─────────────

/** «Клиент» с заданным ответом на любую команду (команды копятся в `cur.sent`); `{stdout,exitCode}` — как code.run клиента. */
export function session(res: Partial<ActionResult> | { stdout: string; exitCode?: number }): ToolContext["session"] {
  cur.sent = [];
  return {
    async sendAction(cmd) {
      cur.sent.push(cmd);
      const base = { commandId: "c", durationMs: 1 };
      if (!("stdout" in res)) return { ...base, ok: false, ...res } as ActionResult;
      const code = res.exitCode ?? 0;
      return code === 0 ? { ...base, ok: true, data: { stdout: res.stdout, stderr: "", exitCode: 0, truncated: false } } : { ...base, ok: false, error: { code: "runtime", message: `код завершился с кодом ${code}` } };
    },
  };
}

// ───────────── саморасширение, знания, самоосмотр ─────────────

/** Реестр самописных инструментов; foreign — у ДРУГОГО арендатора уже лежит инструмент (партиция §6B/B3). */
export function dynKit(foreign = false): DynamicToolStore {
  const store = new DynamicToolStore(new Set(Object.keys(TOOLS_BY_NAME)), { storePath: `${process.env.JARVIS_DATA_DIR}/dyn.json` });
  if (foreign) void store.create("lab-other-tenant", { name: "foreign_tool", description: "чужой", lang: "python", code: "print('чужой код')" });
  cur.act = new Set();
  return (cur.dyn = store);
}
/** Какие имена модель увидит в наборе на следующем ходу (настоящий сборщик набора петли). */
export const toolSet = (tag: string): string[] => makeToolSetBuilder({ toolActivation: cur.act, dynamicTools: cur.dyn, userId: uid(tag) } as never)().tools.map((t) => t.name);

/** База знаний из подложенного md (домен trading). */
export function kbFrom(md: string): KnowledgeBase {
  const dir = `${process.env.JARVIS_DATA_DIR}/kb`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/trading.md`, md);
  return new KnowledgeBase(dir);
}

/** Телеметрия в каталог данных кейса (metrics.jsonl) — сырьё self_weaknesses. Возвращает sessionId для геттера. */
export function seedTelemetry(events: object[]): string {
  const dir = `${process.env.JARVIS_DATA_DIR}/logs`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/metrics.jsonl`, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return "lab-session";
}
export const DAY = 86_400_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
export const degradation = (kind: string, query: string, at = 1000): object => ({ type: "degradation", kind, query, ts: ago(at) });
export const taskEvent = (ok: boolean, failKind?: string, at = 2000): object => ({ ok, rounds: failKind ? 0 : 3, usage: { outputTokens: failKind ? 0 : 100 }, ts: ago(at), ...(failKind ? { failKind } : {}) });

/** Сброс синглтона выученных рецептов программ — начало каждого кейса каналов (для геттера `sessionId`). */
export function freshRecipes(): string {
  resetAppRecipesForTest();
  return "lab-session";
}
