/**
 * A1 (прод 26.09, разбор боевых логов): окно разговора приняло звук фильма БЕЗ «Джарвис» (viaWake=false) —
 * перехват эмоции навсегда записал в профиль подачу «angry», а модель через memory_write — выдуманное «правило
 * владельца». ПЕТЛЁЙ (handleUserText): реплика без обращения долговременное не меняет, но и НЕ глотается
 * (адверс-ревью р2: «ответь Кате, что я злой» уходила в отказ настроек); та же реплика с обращением — меняет.
 * Адресацию судит ЗАДАЧА (старт или её последняя поправка), не сессия (ревью р2: общий флаг гонялся между задачами).
 * Реверт каждого гейта роняет свой кейс (таблица мутаций — в описании PR).
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
import { reflectFactFromUtterance } from "./memory-reflect.js";
import { taskUnaddressed } from "./unaddressed.js";

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
const say = async (userId: string, text: string, meta: { viaWake: boolean }, llm = new MockLlmProvider([{ text: "Ладно." }, { text: "Ладно." }])) => {
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

describe("A1: реплика без обращения «Джарвис» не меняет долговременное и не глотается", () => {
  it("эмоция: без обращения не сохранена, реплика ушла модели; с обращением — сохранена", async () => {
    const a = await say("ua1", "говори зло", UNADDR);
    expect(getProfile("ua1").emotion).not.toBe("angry");
    expect(a.llm.requests.length).toBeGreaterThan(0);
    await say("ua2", "говори зло", ADDR);
    expect(getProfile("ua2").emotion).toBe("angry");
  });

  it("имя: «меня зовут Пётр» без обращения не сохранено; с обращением — сохранено", async () => {
    await say("un1", "меня зовут Пётр", UNADDR);
    expect(getProfile("un1").displayName).not.toBe("Пётр");
    await say("un2", "меня зовут Пётр", ADDR);
    expect(getProfile("un2").displayName).toBe("Пётр");
  });

  it("режим: «будь дерзким» без обращения не сохранён; с обращением — сохранён; «будь собой» без обращения — тоже нет", async () => {
    await say("um1", "будь дерзким", UNADDR);
    expect(getProfile("um1").mode).not.toBe("bold");
    await say("um2", "будь дерзким", ADDR);
    expect(getProfile("um2").mode).toBe("bold");
    await say("um2", "будь собой", UNADDR);
    expect(getProfile("um2").mode).toBe("bold");
  });

  it.each(["ответь Кате, что я злой", "напиши Кате: привет, меня зовут Антон", "закажи пиццу как обычно"])(
    "обычная просьба в окне («%s») не глотается перехватом настроек — её ведёт модель",
    async (text) => {
      const { r, llm } = await say("uw1", text, UNADDR);
      expect(llm.requests.length).toBeGreaterThan(0);
      expect(r.voice).not.toMatch(/настройки не меняю|Возвращаюсь к обычному тону/u);
    },
  );

  it("memory_write без обращения → отказ-остановка (НЕ записал), честное «не могу» не эскалирует на Opus", async () => {
    const FACT = { content: "Владелец запретил присылать голосовые сообщения", kind: "preference" };
    const GIVE_UP = "Не могу записать без обращения — повторите, пожалуйста.";
    const llmA = new MockLlmProvider([call("m1", "memory_write", FACT), { text: GIVE_UP }, { text: GIVE_UP }, { text: GIVE_UP }]);
    await say("ub1", "никаких голосовых сообщений больше", UNADDR, llmA);
    expect(result(llmA, "m1").content).toMatch(/НЕ записал/u);
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

  it("сон-цикл: реплика без обращения И ответ Джарвиса на неё не идут в консолидацию; адресованное — идёт", async () => {
    const { d } = await say("uc1", "я никогда не отвечаю на голосовые", UNADDR, new MockLlmProvider([{ text: "Понял, голосовые пропускаю." }]));
    await handleUserText(session("uc1"), "Джарвис, я люблю кофе", d, undefined, ADDR);
    const kept = consolidationTurns(d.memory.recentTurns()).map((t) => t.text).join(" | ");
    expect(kept).not.toMatch(/голосовые/u); // ни реплика фильма, ни эхо ответа
    expect(kept).toMatch(/люблю кофе/u);
    const restored = new WorkingMemory();
    restored.restore(d.memory.toJSON()); // переживает рестарт (working-store)
    expect(consolidationTurns(restored.recentTurns()).map((t) => t.text).join(" | ")).not.toMatch(/голосовые/u);
  });

  it("петлёй: задача без обращения, адресованная поправка на ходу → memory_write в ЭТОЙ задаче проходит", async () => {
    const tm = new TaskManager();
    const created: Array<{ taskId: string }> = [];
    const create = tm.create.bind(tm);
    tm.create = (o) => {
      const t = create(o);
      created.push(t);
      return t;
    };
    const FACT = { content: "Владелец любит борщ со сметаной", kind: "preference" };
    const inner = new MockLlmProvider([call("s1", "memory_write", FACT), { text: "Запомнил." }, { text: "Запомнил." }]);
    let first = true;
    const llm = Object.assign(Object.create(inner) as MockLlmProvider, {
      complete: async (req: Parameters<MockLlmProvider["complete"]>[0]) => {
        if (first && created.length > 0) {
          first = false;
          tm.steer(created[created.length - 1]!.taskId, "Джарвис, и запомни, что я люблю борщ", true); // владелец адресовал
        }
        return inner.complete(req);
      },
    });
    const d = { ...deps(llm, "us1"), tasks: tm };
    await handleUserText(session("us1"), "найди рецепт борща", d, undefined, UNADDR);
    expect(result(inner, "s1").content).not.toMatch(/НЕ записал/u);
  });

  it("петлёй: правка на ходу без обращения ложится в задачу с пометкой «без обращения» (перехват → steer)", async () => {
    const tm = new TaskManager();
    const task = tm.create({ userId: "ust", sessionId: "s-ust", goal: "найди рецепт борща" });
    const d = { ...deps(new MockLlmProvider([{ text: "Ладно." }]), "ust"), tasks: tm };
    await handleUserText(session("ust"), "добавь в рецепт сметану", d, undefined, UNADDR);
    expect(task.steer.pending).toContain("добавь в рецепт сметану");
    expect(task.steer.lastUnaddressed).toBe(true);
  });

  it("адресация — у ЗАДАЧИ: поправка «Джарвис, …» открывает запись в своей задаче, чужая речь в окне — закрывает", async () => {
    const tm = new TaskManager();
    const task = tm.create({ userId: "ut1", sessionId: "s", goal: "что там по погоде" });
    expect(taskUnaddressed(task, UNADDR)).toBe(true); // старт без обращения
    tm.steer(task.taskId, "и запомни, что я люблю борщ", true);
    expect(taskUnaddressed(task, UNADDR)).toBe(false); // адресованная поправка ЭТОЙ задачи
    tm.steer(task.taskId, "реплика из фильма", false);
    expect(taskUnaddressed(task, ADDR)).toBe(true); // чужая речь, влившаяся в задачу, начатую с обращением
    const other = tm.create({ userId: "ut1", sessionId: "s", goal: "другое" });
    expect(taskUnaddressed(other, ADDR)).toBe(false); // поправки чужой задачи на неё не влияют
  });
});
