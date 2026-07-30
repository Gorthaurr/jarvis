/**
 * ВОЛНА C «Задача не теряется» — интеграционные тесты agent-петли:
 *  (а) упор в контекст-окно СВОРАЧИВАЕТ старые наблюдения, а не хоронит задачу;
 *  (б) прерванная задача оставляет ЧЕКПОЙНТ, а «продолжи» реально продолжает с того же места.
 *
 * Ключевое, что тут защищается — ЧЕСТНОСТЬ: терминал обещает продолжение ТОЛЬКО когда чекпойнт
 * действительно лёг, а свёрнутое наблюдение прямо велит перечитать, а не «вспоминать».
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import type { IWebProvider } from "../../integrations/web.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import type { SkillProvider } from "../../memory/skills.js";
import { TaskManager } from "../tasks/manager.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { RESUME_OFFER_WORD, type TaskCheckpoint } from "./checkpoint.js";
import { autoReplayBlocked } from "./replay-gate.js";
import { type AgentDeps, handleUserText } from "./index.js";

function fakeSession() {
  const sendAction = vi.fn((_cmd: ActionCommand, _t?: number) => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 }));
  const send = vi.fn();
  return { sessionId: "s1", userId: "u1", sendAction, send } as unknown as Session & {
    sendAction: typeof sendAction;
    send: typeof send;
  };
}

async function makeDeps(llm: MockLlmProvider, overrides: Partial<AgentDeps> = {}): Promise<AgentDeps> {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    ...overrides,
  };
}

/** Провайдер навыков, который ЗАПИСЫВАЕТ факт сохранения — для гейта самообучения. */
function fakeSkillsProvider(saved: string[]): SkillProvider {
  return {
    list: async () => [],
    get: async () => null,
    save: async (_u: string, input: { name: string }) => {
      saved.push(input.name);
      return { id: "s1", name: input.name, version: 1 };
    },
    recall: async () => null,
  } as unknown as SkillProvider;
}

const ENV_KEYS = ["JARVIS_CONTEXT_SOFT_TOKENS", "JARVIS_CONTEXT_HARD_TOKENS", "JARVIS_MASK_OBSERVATIONS"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("Волна C: свёртка наблюдений вместо смерти задачи по контекст-окну", () => {
  /** Веб-провайдер: ПЕРВЫЙ поиск отдаёт гигантский дамп, последующие — короткие. */
  function bigThenSmallWeb(): IWebProvider {
    let n = 0;
    return {
      search: async () => {
        n += 1;
        return [{ title: "T", url: "https://x.example", snippet: n === 1 ? "д".repeat(300_000) : "коротко" }];
      },
      fetch: async () => null,
    } as unknown as IWebProvider;
  }

  /** Три tool-раунда (третий с огромным usage → упор в HARD) + финальный текст. */
  const script = [
    { toolUses: [{ id: "t0", name: "web_search", input: { query: "a" } }], usage: { inputTokens: 10_000 } },
    { toolUses: [{ id: "t1", name: "web_search", input: { query: "b" } }], usage: { inputTokens: 140_000 } },
    { toolUses: [{ id: "t2", name: "web_search", input: { query: "c" } }], usage: { inputTokens: 210_000 } },
    { text: "Собрал: три источника, цены от девяноста до ста двадцати тысяч." },
    // 5-й ход — штатная сверка с исходной целью (goal-check петли, к Волне C отношения не имеет).
    { text: "Подтверждаю: отчёт по рынку собран, три источника." },
  ];

  it("задача ПРОДОЛЖАЕТСЯ: старый дамп свёрнут честной заглушкой, свежие наблюдения целы", async () => {
    process.env.JARVIS_CONTEXT_SOFT_TOKENS = "100000";
    process.env.JARVIS_CONTEXT_HARD_TOKENS = "200000";
    const llm = new MockLlmProvider(script);
    const reply = await handleUserText(fakeSession(), "собери отчёт по рынку", await makeDeps(llm, { web: bigThenSmallWeb() }));
    expect(llm.requests.length).toBeGreaterThanOrEqual(4); // 4-й раунд СОСТОЯЛСЯ — гард не убил задачу
    expect(reply.voice).toContain("три источника");
    const last = JSON.stringify(llm.requests[3]?.messages ?? []);
    expect(last).toContain("свёрнуто ради места"); // старое наблюдение заменено заглушкой
    expect(last).toContain("ПЕРЕЧИТАЙ"); // заглушка честная: память за прочитанное не выдавать
    expect(last).toContain("коротко"); // свежие наблюдения НЕ тронуты
  });

  it("выключатель JARVIS_MASK_OBSERVATIONS=0 возвращает прежнее поведение", async () => {
    process.env.JARVIS_CONTEXT_SOFT_TOKENS = "100000";
    process.env.JARVIS_CONTEXT_HARD_TOKENS = "200000";
    process.env.JARVIS_MASK_OBSERVATIONS = "0";
    const llm = new MockLlmProvider(script);
    const reply = await handleUserText(fakeSession(), "собери отчёт по рынку", await makeDeps(llm, { web: bigThenSmallWeb() }));
    expect(llm.requests).toHaveLength(3); // 4-й раунд не начат — свернулись, как раньше
    expect(reply.voice.toLowerCase()).toContain("память");
  });

  it("сворачивать нечего (наблюдения мелкие) → честный свёрток, как прежде", async () => {
    process.env.JARVIS_CONTEXT_SOFT_TOKENS = "20000";
    process.env.JARVIS_CONTEXT_HARD_TOKENS = "30000";
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t0", name: "web_search", input: { query: "x" } }], usage: { inputTokens: 50_000 } },
      { text: "не должно вызваться" },
    ]);
    const reply = await handleUserText(fakeSession(), "сделай отчёт", await makeDeps(llm));
    expect(llm.requests).toHaveLength(1);
    expect(reply.voice.toLowerCase()).toContain("память");
  });
});

describe("Волна C: чекпойнт прерванной задачи и честное «продолжи» (P0 #4)", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-cp-int-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Прервать задачу по контекст-окну — самый быстрый детерминированный обрыв в тесте. */
  async function interruptByContext(deps: AgentDeps, goal = "собери отчёт по продажам"): Promise<string> {
    process.env.JARVIS_CONTEXT_SOFT_TOKENS = "20000";
    process.env.JARVIS_CONTEXT_HARD_TOKENS = "30000";
    const reply = await handleUserText(fakeSession(), goal, deps);
    return reply.voice;
  }

  function interruptedLlm(): MockLlmProvider {
    return new MockLlmProvider([
      { toolUses: [{ id: "t0", name: "web_search", input: { query: "продажи" } }], usage: { inputTokens: 50_000 } },
      { text: "не должно вызваться" },
    ]);
  }

  function storedCp(over: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
    return {
      userId: "u1",
      taskId: "old",
      goal: "собери отчёт по продажам",
      title: "Отчёт по продажам",
      reason: "timeout",
      round: 7,
      savedAt: Date.now(),
      offeredAt: Date.now(), // терминал предложение ПРОИЗНЁС (иначе окно у плеера ничего не отбирает)
      tier: "sonnet",
      digest: "Вызвал web_search(query=продажи) — ok → нашёл три источника",
      ...over,
    };
  }

  it("прерывание сохраняет чекпойнт, и терминал ОБЕЩАЕТ продолжение ОДНОЗНАЧНЫМ словом", async () => {
    const checkpoints = new CheckpointStore(dir);
    const voice = await interruptByContext(await makeDeps(interruptedLlm(), { checkpoints }));
    // Именно «доделай»: «продолжи» принадлежит ещё и плееру и принимается лишь 3 минуты — назвать
    // владельцу слово со скрытым сроком годности = обещание, которое позже жмёт медиа-клавишу.
    expect(voice.toLowerCase()).toContain(RESUME_OFFER_WORD);
    const cp = checkpoints.peek("u1");
    expect(cp).not.toBeNull();
    expect(cp?.goal).toBe("собери отчёт по продажам");
    expect(cp?.reason).toBe("contextWrap");
    expect(cp?.round).toBe(1);
    expect(cp?.digest).toContain("web_search"); // журнал прошлого захода непустой
  });

  it("БЕЗ стора чекпойнтов терминал НЕ обещает продолжение (не врём о том, чего нет)", async () => {
    const voice = await interruptByContext(await makeDeps(interruptedLlm()));
    expect(voice.toLowerCase()).not.toContain(RESUME_OFFER_WORD);
    expect(voice.toLowerCase()).toContain("память");
  });

  it("РАЗГОВОРНЫЙ ход чекпойнт не сохраняет (продолжать нечего — это вопрос)", async () => {
    const checkpoints = new CheckpointStore(dir);
    await interruptByContext(
      await makeDeps(interruptedLlm(), { checkpoints }),
      "почему небо голубое и что об этом думают учёные",
    );
    expect(checkpoints.peek("u1")).toBeNull();
  });

  it("«продолжи» поднимает журнал: петля идёт по ИСХОДНОЙ цели, а не по слову «продолжи»", async () => {
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp());
    const llm = new MockLlmProvider([{ text: "Дособрал, сэр." }]);
    const tasks = new TaskManager();
    const reply = await handleUserText(fakeSession(), "продолжи", await makeDeps(llm, { checkpoints, tasks }));
    expect(llm.requests).toHaveLength(1);
    const msgs = JSON.stringify(llm.requests[0]?.messages ?? []);
    expect(msgs).toContain("ПРОДОЛЖАЕМ ПРЕРВАННУЮ ЗАДАЧУ");
    expect(msgs).toContain("собери отчёт по продажам"); // исходная цель
    expect(msgs).toContain("нашёл три источника"); // журнал прошлого захода
    expect(msgs).toContain("СВЕРЬ текущее состояние"); // наблюдения устарели — пересверить
    expect(tasks.list("u1")[0]?.goal).toBe("собери отчёт по продажам"); // задача по исходной цели
    expect(reply.voice).toContain("Дособрал");
    expect(checkpoints.peek("u1")).toBeNull(); // чекпойнт потреблён (одноразовый)
  });

  it("продолжение идёт на ТОМ ЖЕ тире и с арсеналом холодных инструментов прошлого захода", async () => {
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp({ tier: "fable", toolNames: ["knowledge_consult"] }));
    const llm = new MockLlmProvider([{ text: "Дособрал." }]);
    const toolActivation = new Set<string>();
    await handleUserText(fakeSession(), "продолжи", await makeDeps(llm, { checkpoints, tasks: new TaskManager(), toolActivation }));
    expect(llm.requests[0]?.model).toBe("f"); // тир не понижен
    expect(toolActivation.has("knowledge_consult")).toBe(true);
    expect(llm.requests[0]?.tools?.some((t) => t.name === "knowledge_consult")).toBe(true);
  });

  it("УСПЕШНОЕ продолжение гасит журнал — второе «доделай» его не поднимает", async () => {
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp());
    const llm = new MockLlmProvider([{ text: "Дособрал, сэр." }, { text: "О чём именно?" }]);
    const deps = await makeDeps(llm, { checkpoints, tasks: new TaskManager() });
    await handleUserText(fakeSession(), "доделай", deps);
    expect(checkpoints.peek("u1")).toBeNull(); // задача доведена — продолжать нечего
    await handleUserText(fakeSession(), "доделай", deps);
    expect(JSON.stringify(llm.requests[1]?.messages ?? [])).not.toContain("ПРОДОЛЖАЕМ ПРЕРВАННУЮ ЗАДАЧУ");
  });

  // 🔴 Ревью (HIGH): take() до старта уничтожал журнал 18-раундовой работы, если возобновлённая петля
  // падала на первом же ответе — там saveCheckpoint не зовётся (round=0), и владелец терял ВСЁ.
  it("ПРОВАЛ продолжения (аварийный стаб LLM) журнал НЕ уничтожает — «доделай» ещё работает", async () => {
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp());
    const llm = new MockLlmProvider([{ text: "Связь прервалась", stopReason: "stub" }, { text: "Дособрал, сэр." }]);
    const deps = await makeDeps(llm, { checkpoints, tasks: new TaskManager() });
    await handleUserText(fakeSession(), "доделай", deps);
    expect(checkpoints.peek("u1")).not.toBeNull(); // журнал цел — работа не потеряна
    await handleUserText(fakeSession(), "доделай", deps);
    expect(JSON.stringify(llm.requests[1]?.messages ?? [])).toContain("ПРОДОЛЖАЕМ ПРЕРВАННУЮ ЗАДАЧУ");
  });

  // Ревью: третий заход не видел отправок первого (журнал прошлого захода вытеснялся шапкой врезки)
  // → модель могла повторить уже отправленные людям сообщения.
  it("цепочка продолжений ПОМНИТ первый заход (журналы склеиваются, а не затираются)", async () => {
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp({ digest: "Вызвал telegram_send(to=Катя) — ok → отправлено" }));
    process.env.JARVIS_CONTEXT_SOFT_TOKENS = "20000";
    process.env.JARVIS_CONTEXT_HARD_TOKENS = "30000";
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t0", name: "web_search", input: { query: "миша" } }], usage: { inputTokens: 50_000 } },
      { text: "не должно вызваться" },
    ]);
    await handleUserText(fakeSession(), "доделай", await makeDeps(llm, { checkpoints, tasks: new TaskManager() }));
    const cp2 = checkpoints.peek("u1");
    expect(cp2?.digest).toContain("Катя"); // первый заход не потерян
    expect(cp2?.digest).toContain("web_search"); // и второй записан
    expect(cp2?.digest).toContain("продолжил после перерыва");
  });

  // 🔴 Контрольное ревью-3: журнал текущего захода вклеивался ДВАЖДЫ (алиасинг peek→refreshJournal→
  // saveCheckpoint), и первый заход вытеснялся усечением с ложной причиной «не поместилось».
  it("на повторном прерывании журнал захода вклеивается ОДИН раз (без дубля)", async () => {
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp({ digest: "Вызвал web_search(query=ЗАХОД1) — ok" }));
    process.env.JARVIS_CONTEXT_SOFT_TOKENS = "20000";
    process.env.JARVIS_CONTEXT_HARD_TOKENS = "30000";
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t0", name: "web_search", input: { query: "ЗАХОД2" } }], usage: { inputTokens: 50_000 } },
      { text: "не должно вызваться" },
    ]);
    await handleUserText(fakeSession(), "доделай", await makeDeps(llm, { checkpoints, tasks: new TaskManager() }));
    const d = checkpoints.peek("u1")?.digest ?? "";
    expect(d).toContain("ЗАХОД1"); // первый заход на месте
    expect((d.match(/ЗАХОД2/gu) ?? []).length).toBe(1); // и второй — РОВНО один раз
    expect((d.match(/продолжил после перерыва/gu) ?? []).length).toBe(1);
  });

  // Ревью (HIGH): recall навыка идёт по ИСХОДНОЙ цели, и слепой авто-реплей запускал бы всю
  // процедуру с нуля — ДО того, как модель увидит журнал (врезка ниже блока реплея).
  it("на продолжении слепой авто-реплей макроса ЗАПРЕЩЁН (часть шагов уже сделана)", () => {
    const recalled = { name: "открыть дискорд и написать", when: "написать в дискорд", recallSim: 0.99, recallSimRaw: 0.95 };
    expect(autoReplayBlocked({ text: "напиши в дискорд привет", recalled, conversational: false })).toBeNull();
    expect(autoReplayBlocked({ text: "напиши в дискорд привет", recalled, conversational: false, resuming: true })).toContain(
      "продолжение прерванной задачи",
    );
  });

  // 🔴 Контрольное ревью (HIGH, комбинация двух фиксов): peek оставляет чекпойнт живым, а
  // saveCheckpoint зовут лишь терминалы «прерывания» — значит после провала продолжения, успевшего
  // сделать НЕОБРАТИМОЕ, в сторе лежал журнал ПРОШЛОГО захода, и следующее «доделай» повторяло
  // отправки людям. Журнал обязан включать этот заход при ЛЮБОМ терминале.
  it("провал продолжения ПОСЛЕ мутации обновляет журнал (следующее «доделай» не повторит отправку)", async () => {
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp({ digest: "Вызвал telegram_send(to=Катя) — ok" }));
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "s1", name: "input_click", input: { x: 10, y: 20 } }] }, // мутация мира в этом заходе
      { text: "Связь прервалась", stopReason: "stub" }, // терминал llmStubbed — saveCheckpoint не зовётся
    ]);
    const before = checkpoints.peek("u1")?.offeredAt;
    await handleUserText(fakeSession(), "доделай", await makeDeps(llm, { checkpoints, tasks: new TaskManager() }));
    const cp = checkpoints.peek("u1");
    expect(cp).not.toBeNull();
    expect(cp?.digest).toContain("Катя"); // прошлый заход помним
    expect(cp?.digest).toContain("input_click"); // и ЭТОТ заход тоже — вслепую не повторим
    expect(cp?.offeredAt).toBe(before); // окно предложения НЕ переигрываем: предложения не было
  });

  // 🔴 Контрольное ревью-2 (HIGH): владельцу сказали «Остановил» — значит обещание продолжить больше не
  // в силе. Иначе «доделай» (а в окне и голое «продолжи», сказанное ПЛЕЕРУ) воскрешало ЯВНО
  // остановленную работу, и она снова кликала по экрану.
  it("ОТМЕНА владельцем гасит чекпойнт — «доделай» больше ничего не поднимает", async () => {
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp());
    const tasks = new TaskManager();
    const session = fakeSession();
    // «отмени» владельца ровно посреди работы: отменяем в момент исполнения первого действия.
    session.sendAction.mockImplementation(async () => {
      tasks.cancelUser("u1");
      return { commandId: "c", ok: true, durationMs: 1 };
    });
    const llm = new MockLlmProvider([{ toolUses: [{ id: "c1", name: "input_click", input: { x: 1, y: 1 } }] }, { text: "…" }]);
    await handleUserText(session, "доделай", await makeDeps(llm, { checkpoints, tasks }));
    expect(checkpoints.peek("u1")).toBeNull();
  });

  // 🔴 Финальный контроль (HIGH): обрыв по флуду одним инструментом не выставлял НИ ОДНОГО флага
  // провала → ход доходил до УСПЕШНОГО терминала (ok=true в метриках) и ГАСИЛ чекпойнт продолжения:
  // владельцу говорили «не довёл» и одновременно стирали его недоделку.
  it("обрыв по флуду на ПРОДОЛЖЕНИИ — провал, журнал НЕ стирается", async () => {
    process.env.JARVIS_TOOL_FAMILY_CAP = "3"; // минимум, который принимает кламп: нудж на 3-м, обрыв на 6-м
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp());
    const turns = Array.from({ length: 8 }, (_v, i) => ({
      toolUses: [{ id: `w${i}`, name: "web_search", input: { query: `тема ${i}` } }],
    }));
    const llm = new MockLlmProvider(turns);
    const tasks = new TaskManager();
    const reply = await handleUserText(fakeSession(), "доделай", await makeDeps(llm, { checkpoints, tasks }));
    delete process.env.JARVIS_TOOL_FAMILY_CAP;
    // Честный провал: без преамбулы срабатывает более ранний гард masked-failure («не вышло»), с
    // преамбулой — собственная фраза floodStuck. Оба варианта НЕ заявляют успех.
    expect(reply.voice.toLowerCase()).toMatch(/застрял|не довёл|не вышло/u);
    expect(checkpoints.peek("u1")).not.toBeNull(); // журнал цел — «доделай» ещё сработает
    expect(tasks.recentTerminal("u1")[0]?.state).toBe("failed"); // и это НЕ успех в реестре
  });

  // 🔴 Контроль-5 (HIGH): мой же фикс floodStuck озвучивал ПРЕАМБУЛУ модели дословно и стоял ВЫШЕ
  // анти-masked-failure — на «Готово.» владелец слышал УСПЕХ при `failed` в реестре.
  // Контроль-6: гард isHollowSuccess ловит только ≤3 слов — «Готово, сэр — отчёт по рынку собран.»
  // проходил мимо, и владелец слышал УСПЕХ при failed. Терминал больше НЕ переиспользует текст модели.
  it.each(["Готово.", "Готово, сэр — отчёт по рынку собран.", "Сообщение отправлено Кате, сэр."])(
    "флуд-обрыв с заявкой успеха («%s») → честный провал, преамбула НЕ озвучивается",
    async (preamble) => {
      process.env.JARVIS_TOOL_FAMILY_CAP = "3";
      const turns = Array.from({ length: 8 }, (_v, i) => ({
        text: preamble,
        toolUses: [{ id: `w${i}`, name: "web_search", input: { query: `тема ${i}` } }],
      }));
      const llm = new MockLlmProvider(turns);
      const tasks = new TaskManager();
      const reply = await handleUserText(
        fakeSession(),
        "собери отчёт по рынку",
        await makeDeps(llm, { checkpoints: new CheckpointStore(dir), tasks }),
      );
      delete process.env.JARVIS_TOOL_FAMILY_CAP;
      expect(reply.voice).not.toContain("собран");
      expect(reply.voice).not.toContain("отправлено");
      expect(reply.voice.toLowerCase()).toMatch(/застрял|не вышло|не довёл/u);
      expect(tasks.recentTerminal("u1")[0]?.state).toBe("failed"); // голос и реестр согласованы
    },
  );

  it("флуд-обрыв без преамбулы → честный провал, журнал цел", async () => {
    process.env.JARVIS_TOOL_FAMILY_CAP = "3";
    const checkpoints = new CheckpointStore(dir);
    const turns = Array.from({ length: 8 }, (_v, i) => ({
      toolUses: [{ id: `w${i}`, name: "web_search", input: { query: `тема ${i}` } }],
    }));
    const llm = new MockLlmProvider(turns);
    const tasks = new TaskManager();
    const reply = await handleUserText(fakeSession(), "собери отчёт по рынку", await makeDeps(llm, { checkpoints, tasks }));
    delete process.env.JARVIS_TOOL_FAMILY_CAP;
    expect(reply.voice.toLowerCase()).not.toBe("готово.");
    expect(reply.voice.toLowerCase()).toMatch(/не вышло|не довёл|застрял/u);
    expect(tasks.recentTerminal("u1")[0]?.state).toBe("failed"); // голос и реестр согласованы
  });

  // 🔴 Контроль-5 (MED): флуд-провал запускал САМООБУЧЕНИЕ — рефлексия на Opus утверждала «Задача
  // решена» и сохраняла навык из траектории, которая НЕ привела к результату.
  it("флуд-провал НЕ запускает самообучение (навык из провала не сохраняется)", async () => {
    process.env.JARVIS_TOOL_FAMILY_CAP = "3";
    const saved: string[] = [];
    const skills = fakeSkillsProvider(saved);
    const turns = Array.from({ length: 8 }, (_v, i) => ({
      toolUses: [{ id: `w${i}`, name: "web_search", input: { query: `тема ${i}` } }],
    }));
    const llm = new MockLlmProvider(turns);
    await handleUserText(
      fakeSession(),
      "собери отчёт по рынку",
      await makeDeps(llm, { checkpoints: new CheckpointStore(dir), tasks: new TaskManager(), skills }),
    );
    delete process.env.JARVIS_TOOL_FAMILY_CAP;
    expect(saved).toEqual([]);
  });

  // Ревью: машинный реэнтри (watch-action) перетирал недоделку ВЛАДЕЛЬЦА — слот один на пользователя.
  it("машинный ход (watch-action) чекпойнт НЕ пишет и чужой не трогает", async () => {
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp({ goal: "дело владельца" }));
    process.env.JARVIS_CONTEXT_SOFT_TOKENS = "20000";
    process.env.JARVIS_CONTEXT_HARD_TOKENS = "30000";
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t0", name: "web_search", input: { query: "x" } }], usage: { inputTokens: 50_000 } },
      { text: "не должно вызваться" },
    ]);
    await handleUserText(
      fakeSession(),
      "напиши кате что заказ доставлен",
      await makeDeps(llm, { checkpoints, tasks: new TaskManager() }),
      undefined,
      { origin: "watch-action" },
    );
    expect(checkpoints.peek("u1")?.goal).toBe("дело владельца"); // недоделка владельца на месте
  });

  it("«продолжи видео» чекпойнт НЕ трогает (позитивный allowlist: это медиа-команда)", async () => {
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp());
    const llm = new MockLlmProvider([{ text: "не должно понадобиться" }]);
    await handleUserText(fakeSession(), "продолжи видео", await makeDeps(llm, { checkpoints, tasks: new TaskManager() }));
    expect(checkpoints.peek("u1")).not.toBeNull(); // журнал на месте — перехват не сработал
  });

  it("«продолжи» БЕЗ чекпойнта не перехватывается — прежний путь (tier0-медиа) без регресса", async () => {
    const checkpoints = new CheckpointStore(dir);
    const session = fakeSession();
    const llm = new MockLlmProvider([{ text: "не должно вызваться" }]);
    await handleUserText(session, "продолжи", await makeDeps(llm, { checkpoints, tasks: new TaskManager() }));
    expect(llm.requests).toHaveLength(0); // ушло в tier0 (снять видео с паузы), как и до Волны C
    expect(session.sendAction.mock.calls[0]?.[0]?.kind).toBe("system.media");
  });

  // Контрольное ревью: сохранить можно молча (сбой записи на диск, обновление журнала после провала),
  // но окно у плеера отбирает только РЕАЛЬНО прозвучавшее предложение.
  it("чекпойнт без произнесённого предложения окно НЕ взводит — «продолжи» идёт плееру", async () => {
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp({ offeredAt: undefined }));
    const session = fakeSession();
    const llm = new MockLlmProvider([{ text: "не должно вызваться" }]);
    await handleUserText(session, "продолжи", await makeDeps(llm, { checkpoints, tasks: new TaskManager() }));
    expect(session.sendAction.mock.calls[0]?.[0]?.kind).toBe("system.media");
    expect(checkpoints.peek("u1")).not.toBeNull();
  });

  it("голое «продолжи» ВНЕ окна предложения отдаётся плееру — чекпойнт не украден и цел", async () => {
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp({ savedAt: Date.now() - 10 * 60_000, offeredAt: Date.now() - 10 * 60_000 })); // старше окна (3 мин)
    const session = fakeSession();
    const llm = new MockLlmProvider([{ text: "не должно вызваться" }]);
    await handleUserText(session, "продолжи", await makeDeps(llm, { checkpoints, tasks: new TaskManager() }));
    expect(session.sendAction.mock.calls[0]?.[0]?.kind).toBe("system.media");
    expect(checkpoints.peek("u1")).not.toBeNull(); // журнал дождётся однозначной формы
  });

  // Ревью: гард «фраза принадлежит плееру» считался на СВОЕЙ нормализации — ведущее «давай»/«ну»
  // роутер срезает, а гард нет → «давай продолжи» проходило мимо окна предложения.
  it("ведущие филлеры не отключают гард плеера: «давай продолжи» вне окна — плееру", async () => {
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp({ savedAt: Date.now() - 10 * 60_000, offeredAt: Date.now() - 10 * 60_000 }));
    const session = fakeSession();
    const llm = new MockLlmProvider([{ text: "не должно вызваться" }]);
    await handleUserText(session, "давай продолжи", await makeDeps(llm, { checkpoints, tasks: new TaskManager() }));
    expect(checkpoints.peek("u1")).not.toBeNull();
    expect(llm.requests).toHaveLength(0);
  });

  // 🔴 Контрольное ревью-2: одного вежливого слова хватало, чтобы якорный матчер роутера промолчал и
  // гард плеера отключился — «теперь продолжай» поднимало старую задачу все 30 минут TTL.
  it("«теперь продолжай» вне окна предложения чекпойнт НЕ берёт (гард по форме, не по матчеру)", async () => {
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp({ savedAt: Date.now() - 10 * 60_000, offeredAt: Date.now() - 10 * 60_000 }));
    const llm = new MockLlmProvider([{ text: "не резюме" }]);
    await handleUserText(fakeSession(), "теперь продолжай", await makeDeps(llm, { checkpoints, tasks: new TaskManager() }));
    expect(checkpoints.peek("u1")).not.toBeNull();
    expect(JSON.stringify(llm.requests[0]?.messages ?? [])).not.toContain("ПРОДОЛЖАЕМ ПРЕРВАННУЮ ЗАДАЧУ");
  });

  it("и наоборот — «эй, доделай» распознаётся как продолжение (нормализация как у роутера)", async () => {
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp({ savedAt: Date.now() - 10 * 60_000 }));
    const llm = new MockLlmProvider([{ text: "Дособрал." }]);
    await handleUserText(fakeSession(), "эй, доделай", await makeDeps(llm, { checkpoints, tasks: new TaskManager() }));
    expect(JSON.stringify(llm.requests[0]?.messages ?? [])).toContain("ПРОДОЛЖАЕМ ПРЕРВАННУЮ ЗАДАЧУ");
  });

  it("однозначная форма («доделай») поднимает журнал и вне окна предложения", async () => {
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp({ savedAt: Date.now() - 10 * 60_000 }));
    const llm = new MockLlmProvider([{ text: "Дособрал, сэр." }]);
    await handleUserText(fakeSession(), "доделай", await makeDeps(llm, { checkpoints, tasks: new TaskManager() }));
    expect(JSON.stringify(llm.requests[0]?.messages ?? [])).toContain("ПРОДОЛЖАЕМ ПРЕРВАННУЮ ЗАДАЧУ");
  });

  it("при АКТИВНОЙ задаче «продолжи» в резюме-перехват не идёт (там pause/resume-механика §20)", async () => {
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp());
    const tasks = new TaskManager();
    tasks.create({ userId: "u1", sessionId: "s1", goal: "идущая работа" });
    const llm = new MockLlmProvider([{ text: "ок" }]);
    await handleUserText(fakeSession(), "продолжи", await makeDeps(llm, { checkpoints, tasks }));
    expect(checkpoints.peek("u1")).not.toBeNull();
  });

  it("протухший чекпойнт не поднимается (мир ушёл вперёд — честнее начать заново)", async () => {
    process.env.JARVIS_CHECKPOINT_TTL_MS = "60000";
    const checkpoints = new CheckpointStore(dir);
    checkpoints.save(storedCp({ savedAt: Date.now() - 120_000 }));
    const llm = new MockLlmProvider([{ text: "не должно вызваться" }]);
    await handleUserText(fakeSession(), "доделай", await makeDeps(llm, { checkpoints, tasks: new TaskManager() }));
    delete process.env.JARVIS_CHECKPOINT_TTL_MS;
    expect(JSON.stringify(llm.requests[0]?.messages ?? [])).not.toContain("ПРОДОЛЖАЕМ ПРЕРВАННУЮ ЗАДАЧУ");
  });
});
