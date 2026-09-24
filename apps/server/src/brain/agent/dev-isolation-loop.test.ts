/**
 * Ревью 2026-09-24, T-F1 и T-F3 — проверяем ПЕТЛЁЙ и настоящим makeSessionContext.
 *
 * T-F1: текст-драйвер (dev-сессия) работал на ТОЙ ЖЕ рабочей памяти, что и владелец (тот же DEV_USER). 09.09 реплика
 * драйвера «выруби музыку» осела в памяти, и через час на голосовое «ты меня слышишь?» Джарвис поставил видео
 * владельца на паузу. Теперь dev-сессия — своя память, её задачи не в «что я сделал», не на диск, без самообучения.
 *
 * T-F3: шумный recall (сырой косинус 0.77–0.88 к ЧУЖОЙ задаче) получал кредит исхода и вписывал в себя слепой макрос
 * жестов чужой задачи. Теперь — только навык, сохранённый в этой задаче, или вспомненный уверенно (≥ 0.9).
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import { dispatch as wsDispatch, makeSessionContext, type BrainProviders } from "../../gateway/router-ws.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockSttProvider, MockTtsProvider } from "../../integrations/voice-providers.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { flushWorkingStores, loadWorkingMemory } from "../../memory/working-store.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";
import { CONFIDENT_RECALL_RAW_COS, confidentRecall } from "./loop/finalize.js";

function session(): Session {
  const scopes = new Map<string, unknown>();
  return {
    sessionId: "s1",
    userId: "u1",
    // screen.capture отдаёт кадр (иначе сверка глазами — ошибка, и ход не успешен → ассерты про кредит декоративны).
    sendAction: vi.fn((c: ActionCommand) =>
      Promise.resolve({
        commandId: "c",
        ok: true,
        durationMs: 1,
        ...(c.kind === "screen.capture" ? { data: { image: "iVBORw0KGgo=", mediaType: "image/png" } } : {}),
      }),
    ),
    send: vi.fn(),
    requestConfirm: vi.fn(),
    onTeardown: vi.fn(),
    channelUp: true,
    scoped: <T>(key: string, init: () => T): T => {
      if (!scopes.has(key)) scopes.set(key, init());
      return scopes.get(key) as T;
    },
  } as unknown as Session;
}

function deps(llm: MockLlmProvider, tasks: TaskManager, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks,
    ...over,
  } as AgentDeps;
}

/** Навык, который recall «вспомнил» с заданным сырым косинусом; фиксирует кредит исхода и вписанный макрос. */
function recordingSkills(rawCos: number) {
  const outcomes: Array<{ id: string; ok: boolean }> = [];
  const macros: string[] = [];
  const skills = {
    list: async () => [],
    get: async () => null,
    save: async () => null,
    recall: async () => ({
      id: "sk-noise",
      name: "Поставить видео на паузу",
      when: "просят остановить видео",
      procedure: "browser_act pause",
      version: 1,
      recallSim: 0.9,
      recallSimRaw: rawCos,
    }),
    recordOutcome: async (_u: string, id: string, ok: boolean) => {
      outcomes.push({ id, ok });
    },
    attachReplay: async (_u: string, id: string) => {
      macros.push(id);
      return true;
    },
  } as unknown as AgentDeps["skills"];
  return { skills, outcomes, macros };
}

/** Ход с успешным физическим жестом (попадает в gestureTrace) и сверкой глазами → taskOk. */
const gestureTurn = () =>
  new MockLlmProvider([
    { toolUses: [{ id: "k1", name: "input_key", input: { combo: "space" } }] },
    { toolUses: [{ id: "v1", name: "screen_capture", input: {} }] },
    { text: "Нажал пробел, сэр, видео на паузе — видно на экране." },
  ]);

describe("T-F1: dev-сессия изолирована от памяти и истории владельца", () => {
  it("makeSessionContext: dev-клиент получает СВОЮ рабочую память и флаг devSession; живой клиент — нет", () => {
    const brain = {
      llm: new MockLlmProvider([]),
      episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
      web: new MockWebProvider(),
      models: { haiku: "h", sonnet: "s", fable: "f" },
      spend: { forUser: () => new SpendGuard() },
      tasks: new TaskManager(),
      extBridge: { connected: false, telegramSend: vi.fn(), telegramSendVoice: vi.fn(), openOrFocus: vi.fn() },
    } as unknown as BrainProviders;
    const voice = { stt: new MockSttProvider(), tts: new MockTtsProvider() } as never;
    // На диске уже есть разговор ВЛАДЕЛЬЦА (u1) — живой клиент обязан его поднять, dev-сессия — нет.
    const owner = loadWorkingMemory("u1");
    owner.pushTurn("user", "реплика владельца");
    flushWorkingStores();
    const dev = makeSessionContext(session(), { stop: vi.fn() } as never, voice, brain, "cmd-test");
    const live = makeSessionContext(session(), { stop: vi.fn() } as never, voice, brain, "0.1.0");
    expect(dev.agentDeps.devSession).toBe(true);
    expect(live.agentDeps.devSession).toBe(false);
    const texts = (m: WorkingMemory) => m.toJSON().turns.map((t) => t.text);
    expect(texts(live.agentDeps.memory)).toContain("реплика владельца");
    expect(texts(dev.agentDeps.memory)).not.toContain("реплика владельца"); // до фикса: dev поднимал память владельца
    // И обратно: реплика драйвера не оседает на диске владельца.
    dev.agentDeps.memory.pushTurn("user", "выруби музыку");
    flushWorkingStores();
    expect(texts(loadWorkingMemory("u1"))).not.toContain("выруби музыку");
    void wsDispatch; // импорт держим: проводка dispatch → тот же ctx (см. selection-wiring.test)
  });

  it("задача dev-сессии не всплывает в «что я сделал» и не пишется на диск", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "r1", name: "fs_write", input: { path: "C:/tmp/smoke.txt", content: "x" } }] },
      { text: "Файл записан, сэр." },
    ]);
    await handleUserText(session(), "создай файл smoke.txt с буквой икс", deps(llm, tasks, { devSession: true }));
    const all = tasks.list("u1");
    expect(all.length).toBeGreaterThan(0); // без задачи ассерты ниже декоративны
    expect(tasks.recentTerminal("u1")).toHaveLength(0);
    expect(tasks.toJSON().tasks).toHaveLength(0);
  });

  it("memory_write из dev-сессии не пишет в долговременную память владельца", async () => {
    const tasks = new TaskManager();
    const episodic = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "m1", name: "memory_write", input: { content: "владелец любит тестовые фикстуры", kind: "fact" } }] },
      { text: "Запомнил." },
    ]);
    await handleUserText(session(), "запомни что я люблю тестовые фикстуры", deps(llm, tasks, { devSession: true, episodic }));
    expect(await episodic.hasEntries?.("u1")).toBeFalsy();
  });

  it("dev-сессия не кредитует навык и не вписывает макрос даже при уверенном recall", async () => {
    const tasks = new TaskManager();
    const { skills, outcomes, macros } = recordingSkills(0.95);
    await handleUserText(session(), "поставь видео на паузу пробелом", deps(gestureTurn(), tasks, { devSession: true, skills }));
    expect(outcomes).toHaveLength(0);
    expect(macros).toHaveLength(0);
  });
});

describe("T-F3: исход и макрос — только уверенно вспомненному навыку", () => {
  it("порог: сырой косинус ≥ 0.9, лексический recall (без косинуса) уверенным не считается", () => {
    expect(confidentRecall({ recallSimRaw: CONFIDENT_RECALL_RAW_COS })).toBe(true);
    expect(confidentRecall({ recallSimRaw: 0.87 })).toBe(false);
    expect(confidentRecall({})).toBe(false);
    expect(confidentRecall(null)).toBe(false);
  });

  it("шумный recall (0.8) — ни кредита, ни макроса", async () => {
    const tasks = new TaskManager();
    const { skills, outcomes, macros } = recordingSkills(0.8);
    await handleUserText(session(), "поставь видео на паузу пробелом", deps(gestureTurn(), tasks, { skills }));
    expect(tasks.list("u1")[0]?.state).toBe("done"); // ход успешен — иначе проверка ниже ничего не доказывает
    expect(outcomes).toHaveLength(0);
    expect(macros).toHaveLength(0);
  });

  it("уверенный recall (0.95) — кредит и макрос получает он", async () => {
    const tasks = new TaskManager();
    const { skills, outcomes, macros } = recordingSkills(0.95);
    await handleUserText(session(), "поставь видео на паузу пробелом", deps(gestureTurn(), tasks, { skills }));
    expect(outcomes).toEqual([{ id: "sk-noise", ok: true }]);
    expect(macros).toEqual(["sk-noise"]);
  });
});

// Контроль-1 №5 (ревью 2026-09-24): реплей разрешён с сырого косинуса 0,84, а исход кредитовался только с 0,9 —
// провальный макрос в этом зазоре не копил fail_count и слепо реплеился при каждой такой команде.
// Реверт: убери `|| st.progress.macroReplayed` в loop/finalize.ts — outcomes будет пуст.
describe("исход получает навык, чей авто-реплей реально исполнялся", () => {
  it("recall 0,86 (ниже «уверенного» 0,9), макрос ушёл на клиент → исход записан этому навыку", async () => {
    const tasks = new TaskManager();
    const outcomes: Array<{ id: string; ok: boolean }> = [];
    const skills = {
      list: async () => [],
      get: async () => null,
      save: async () => null,
      recall: async () => ({
        id: "sk-macro",
        name: "Поставить видео на паузу пробелом",
        when: "просят поставить видео на паузу",
        procedure: "нажми пробел",
        version: 2,
        recallSim: 0.95,
        recallSimRaw: 0.86,
        steps: [
          { action: "input.key", params: { combo: "space" } },
          { action: "wait", params: { ms: 400 } },
        ],
      }),
      recordOutcome: async (_u: string, id: string, ok: boolean) => {
        outcomes.push({ id, ok });
      },
    } as unknown as AgentDeps["skills"];
    const s = session();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "v1", name: "screen_capture", input: {} }] },
      { text: "Видео на паузе, сэр — видно на экране." },
    ]);
    await handleUserText(s, "поставь видео на паузу пробелом", deps(llm, tasks, { skills }), undefined, { viaWake: true });
    const kinds = (s.sendAction as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as ActionCommand).kind);
    expect(kinds).toContain("skill.execute"); // реплей реально ушёл — иначе ассерт ниже ничего не доказывает
    expect(outcomes.map((o) => o.id)).toEqual(["sk-macro"]);
  });
});
