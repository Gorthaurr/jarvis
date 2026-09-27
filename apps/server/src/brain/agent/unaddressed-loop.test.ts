/**
 * A1 (прод 26.09, разбор боевых логов): окно разговора приняло звук фильма БЕЗ «Джарвис» (viaWake=false) —
 * перехват эмоции навсегда записал в профиль подачу «angry», а модель через memory_write — выдуманное «правило
 * владельца». ПЕТЛЁЙ (handleUserText): реплика без обращения долговременное не меняет и честно об этом говорит;
 * та же реплика с обращением — меняет (контроль: гейт не сломал саму функцию).
 * Реверт каждого гейта роняет свой кейс: эмоция/имя/режим (turn-intercepts), memory_write/forget (dispatch,
 * + declined, иначе анти-капитуляция жжёт Opus), рефлекс фактов (fireReflexes), сон-цикл (consolidationTurns),
 * судит последняя реплика (index.ts → deps.unaddressedUtterance, tool-ctx getter).
 */
import { describe, expect, it, vi } from "vitest";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider, type MockTurn } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory, consolidationTurns } from "../../memory/working.js";
import { getProfile } from "../profile.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";
import { makeToolCtx } from "./loop/tool-ctx.js";
import { reflectFactFromUtterance } from "./memory-reflect.js";

// Рефлекс фактов — шпион (у настоящего глобальные кап/троттлинг: проверяем гейт fireReflexes, а не предохранители).
vi.mock("./memory-reflect.js", async (orig) => ({ ...(await orig<typeof import("./memory-reflect.js")>()), reflectFactFromUtterance: vi.fn(async () => {}) }));

const session = (userId: string) =>
  ({ sessionId: `s-${userId}`, userId, sendAction: vi.fn(), send: vi.fn(), requestConfirm: vi.fn() }) as unknown as Session;
const deps = (llm: MockLlmProvider, userId: string): AgentDeps => ({
  memory: new WorkingMemory(),
  llm,
  episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
  web: new MockWebProvider(),
  models: { haiku: "h", sonnet: "s", fable: "f" },
  spend: new SpendGuard(),
  userId,
  tasks: new TaskManager(),
});
const call = (id: string, name: string, input: Record<string, unknown>): MockTurn => ({ toolUses: [{ id, name, input }] });
const UNADDR = { viaWake: false } as const;
const ADDR = { viaWake: true } as const;
const say = async (userId: string, text: string, meta: { viaWake: boolean }, llm = new MockLlmProvider([{ text: "Ладно." }])) => {
  const d = deps(llm, userId);
  const r = await handleUserText(session(userId), text, d, undefined, meta);
  return { r, d, llm };
};

/** tool_result вызова `id` из запросов к модели. */
function result(llm: MockLlmProvider, id: string): { content: string; isError: boolean } {
  for (const req of [...llm.requests].reverse()) {
    for (const m of req.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
        if (b.type === "tool_result" && b.tool_use_id === id) return { content: JSON.stringify(b.content), isError: b.is_error === true };
      }
    }
  }
  throw new Error(`нет tool_result для ${id}`);
}

describe("A1: реплика без обращения «Джарвис» не меняет долговременное", () => {
  it("эмоция: без обращения не сохранена и честный отказ вслух; с обращением — сохранена", async () => {
    const { r } = await say("ua1", "говори зло", UNADDR);
    expect(getProfile("ua1").emotion).not.toBe("angry");
    expect(r.voice).toMatch(/Без обращения настройки не меняю/u);
    await say("ua2", "говори зло", ADDR);
    expect(getProfile("ua2").emotion).toBe("angry");
  });

  it("имя: «меня зовут Пётр» без обращения не сохранено; с обращением — сохранено", async () => {
    await say("un1", "меня зовут Пётр", UNADDR);
    expect(getProfile("un1").displayName).not.toBe("Пётр");
    await say("un2", "меня зовут Пётр", ADDR);
    expect(getProfile("un2").displayName).toBe("Пётр");
  });

  it("режим: «будь дерзким» без обращения не сохранён; СБРОС «будь собой» без обращения — можно", async () => {
    await say("um1", "будь дерзким", UNADDR);
    expect(getProfile("um1").mode).not.toBe("bold");
    await say("um2", "будь дерзким", ADDR);
    expect(getProfile("um2").mode).toBe("bold");
    await say("um2", "будь собой", UNADDR); // безопасное направление не блокируем
    expect(getProfile("um2").mode).toBe("butler");
  });

  it("memory_write без обращения → отказ-остановка (НЕ записал), честное «не могу» не эскалирует на Opus", async () => {
    const FACT = { content: "Владелец запретил присылать голосовые сообщения", kind: "preference" };
    const GIVE_UP = "Не могу записать без обращения — повторите, пожалуйста.";
    const llmA = new MockLlmProvider([call("m1", "memory_write", FACT), { text: GIVE_UP }, { text: GIVE_UP }, { text: GIVE_UP }]);
    await say("ub1", "никаких голосовых сообщений больше", UNADDR, llmA);
    const refused = result(llmA, "m1");
    expect(refused.content).toMatch(/НЕ записал/u);
    expect(llmA.requests.map((q) => q.model)).not.toContain("f"); // нет эскалации §7 на отказ политикой
    expect(llmA.requests).toHaveLength(2); // раунд инструмента + финал, без нуджа анти-капитуляции

    const llmB = new MockLlmProvider([call("m2", "memory_write", FACT), { text: "Понял." }, { text: "Понял." }]);
    await say("ub2", "никаких голосовых сообщений больше", ADDR, llmB);
    expect(result(llmB, "m2").content).not.toMatch(/НЕ записал/u);
  });

  it("memory_forget без обращения → отказ (ничего не забыл)", async () => {
    const llm = new MockLlmProvider([call("f1", "memory_forget", { query: "голосовые" }), { text: "Не забыл." }, { text: "Не забыл." }]);
    await say("uf1", "забудь про голосовые", UNADDR, llm);
    expect(result(llm, "f1").content).toMatch(/ничего не забыл/u);
  });

  it("рефлекс фактов: «я всегда пью кофе без сахара» без обращения — не запускается; с обращением — запускается", async () => {
    const spy = vi.mocked(reflectFactFromUtterance);
    spy.mockClear();
    await say("ur1", "я всегда пью кофе без сахара", UNADDR);
    expect(spy).not.toHaveBeenCalled();
    await say("ur2", "я всегда пью кофе без сахара", ADDR);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("сон-цикл: реплика без обращения помечена в рабочей памяти и в консолидацию не идёт", async () => {
    const { d } = await say("uc1", "я никогда не отвечаю на голосовые", UNADDR);
    const turns = d.memory.recentTurns();
    expect(turns.find((t) => t.role === "user")?.unaddressed).toBe(true);
    expect(consolidationTurns(turns).some((t) => t.text.includes("голосовые"))).toBe(false);
    const restored = new WorkingMemory();
    restored.restore(d.memory.toJSON()); // переживает рестарт (working-store)
    expect(consolidationTurns(restored.recentTurns()).some((t) => t.text.includes("голосовые"))).toBe(false);
  });

  it("судит ПОСЛЕДНЯЯ реплика: задача начата без обращения, правка «Джарвис, …» открывает запись (и наоборот)", async () => {
    const d = deps(new MockLlmProvider([{ text: "Ладно." }, { text: "Ладно." }]), "us1");
    const ctx = makeToolCtx(d, session("us1"), { viaWake: false });
    await handleUserText(session("us1"), "что там по погоде", d, undefined, UNADDR);
    expect(ctx.unaddressedTurn).toBe(true);
    await handleUserText(session("us1"), "Джарвис, и запомни, что я люблю борщ", d, undefined, ADDR);
    expect(ctx.unaddressedTurn).toBe(false); // тот же ToolContext задачи видит свежую адресацию
  });
});
