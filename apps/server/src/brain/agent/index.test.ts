import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, SkillStep } from "@jarvis/protocol";
import { type ILlmProvider, type LlmRequest, streamViaComplete } from "../../integrations/llm.js";
import { SpendGuard } from "../../billing/index.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import type { Session } from "../../gateway/session.js";
import { TaskManager } from "../tasks/manager.js";
import type { TaskStatus } from "@jarvis/protocol";
import type { SkillProvider } from "../../memory/skills.js";
import { type AgentDeps, handleUserText, replayUnsafe, waitForChannel, waitWhilePaused } from "./index.js";
import type { Task } from "../tasks/task.js";

/** Заглушка провайдера навыков (§8): по умолчанию пусто; точечно переопределяется в тестах. */
function fakeSkills(over: Partial<SkillProvider> = {}): SkillProvider {
  return {
    list: async () => [],
    get: async () => null,
    save: async (_u, input) => ({ id: "saved", name: input.name, version: 1 }),
    recall: async () => null,
    ...over,
  };
}

function fakeSession(
  sendAction = vi.fn((_cmd: ActionCommand, _t?: number) =>
    Promise.resolve({ commandId: "c", ok: true, durationMs: 1 }),
  ),
) {
  // send — приёмник конвертов (task.status §20 и пр.); в тестах пишем в шпион.
  const send = vi.fn();
  return { sessionId: "s1", userId: "u1", sendAction, send } as unknown as Session & {
    sendAction: typeof sendAction;
    send: typeof send;
  };
}

async function makeDeps(llm: MockLlmProvider, overrides: Partial<AgentDeps> = {}): Promise<AgentDeps> {
  const episodic = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
  return {
    memory: new WorkingMemory(),
    llm,
    episodic,
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    ...overrides,
  };
}

describe("agent-loop (§7, §8)", () => {
  it("tier0: «открой блокнот» → ActionCommand app.launch (без LLM)", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider();
    const reply = await handleUserText(session, "открой блокнот", await makeDeps(llm));
    expect(session.sendAction).toHaveBeenCalledTimes(1);
    const cmd = session.sendAction.mock.calls[0]?.[0];
    expect(cmd?.kind).toBe("app.launch");
    // Формулировка ротируется (вариативность §11), но объект всегда назван — проверяем его.
    expect(reply.voice.toLowerCase()).toContain("блокнот");
    expect(llm.requests).toHaveLength(0); // tier0 не зовёт LLM
  });

  it("§20 «забывашка»: вопрос-продолжение при активной задаче НЕ теряет контекст диалога", async () => {
    // Регрессия: «ты отправил?» классифицировалось как new → freshContext → агент получал ТОЛЬКО
    // «ты отправил?» без истории → «не вижу, о каком сообщении речь». Теперь свежая задача всё равно
    // несёт короткое окно последних реплик. Активная задача в сессии → срабатывает freshContext-путь.
    const session = fakeSession();
    const llm = new MockLlmProvider(); // дефолт → «Готово.» одним ходом, без tool-use
    const memory = new WorkingMemory();
    memory.pushTurn("user", "Отправь голосовое Кате в телеграм");
    memory.pushTurn("assistant", "Записать Кате голосовое — отправляю?");
    memory.pushTurn("user", "Да, отправляй");
    memory.pushTurn("assistant", "Не вышло — расширение не ответило, голосовое Кате не ушло.");
    const tasks = new TaskManager();
    tasks.create({ userId: "u1", sessionId: "s1", goal: "Отправь голосовое Кате" }); // активная (running)

    await handleUserText(session, "ты отправил?", await makeDeps(llm, { memory, tasks }));

    expect(llm.requests.length).toBeGreaterThanOrEqual(1);
    const msgs = llm.requests[0]?.messages ?? [];
    const joined = msgs.map((m) => String(m.content)).join("\n");
    expect(joined).toContain("голосовое Кате"); // прежний запрос виден агенту
    expect(joined).toContain("Не вышло"); // и факт провала — ответит честно, а не «не вижу о чём речь»
    expect(joined).toContain("ты отправил?"); // и сама реплика на месте (заканчивается ею)
  });

  it("Фаза 3: лексический промах recall → каталог выученных навыков в systemDynamic (Claude применит по смыслу)", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider(); // дефолт «Готово.» одним ходом
    const skills: SkillProvider = {
      list: async () => [],
      get: async () => null,
      save: async () => null,
      recall: async () => null, // ЛЕКСИЧЕСКИЙ ПРОМАХ → должен сработать каталог
      learnedCatalog: async () => [{ name: "Отправить Герману", when: "когда нужно написать Herman в телеграм" }],
    };
    await handleUserText(session, "что там по работе нужно", await makeDeps(llm, { skills }));
    expect(llm.requests.length).toBeGreaterThanOrEqual(1);
    const dyn = llm.requests[0]?.systemDynamic ?? "";
    expect(dyn).toContain("Твои выученные навыки"); // каталог в НЕкешируемой динамике
    expect(dyn).toContain("Отправить Герману");
  });

  it("Фаза 3: при УСПЕШНОМ recall каталог НЕ дублируется (полная процедура в systemSkill)", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider();
    const skills: SkillProvider = {
      list: async () => [],
      get: async () => null,
      save: async () => null,
      recall: async () => ({ id: "tg", ownerId: "u-1", name: "Отправить Герману", when: "написать Herman", procedure: "шаги...", version: 1 }),
      learnedCatalog: async () => [{ name: "Отправить Герману", when: "написать Herman" }],
    };
    await handleUserText(session, "что там по работе нужно", await makeDeps(llm, { skills }));
    const req = llm.requests[0];
    expect(req?.systemSkill ?? "").toContain("шаги..."); // процедура в кеш-блоке
    expect(req?.systemDynamic ?? "").not.toContain("Твои выученные навыки"); // каталог НЕ инжектится (recall попал)
  });

  it("tool-use: memory_search → финальный ответ (retrieval §8)", async () => {
    const session = fakeSession();
    const deps = await makeDeps(
      new MockLlmProvider([
        { toolUses: [{ id: "t1", name: "memory_search", input: { query: "зал" } }] },
        { text: "Ты в зал ходишь по понедельникам." },
      ]),
    );
    await deps.episodic.write({ userId: "u1", kind: "fact", text: "ходит в зал по понедельникам", ts: 1 });

    const reply = await handleUserText(session, "что там у меня с залом", deps);
    expect(reply.voice).toContain("зал");
    const llm = deps.llm as MockLlmProvider;
    expect(llm.requests).toHaveLength(2);
    // Инструменты предложены модели; skill_execute (§8) предлагается; demo_record из UI.
    // message_send/order_place УБРАНЫ из набора (userbot/mock, не в концепции): мессенджеры/
    // заказы Джарвис делает через интерфейс как человек (browser_*/ui_*/input_*).
    const toolNames = (llm.requests[0]?.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("memory_search");
    expect(toolNames).toContain("skill_execute");
    expect(toolNames).toContain("skill_list");
    expect(toolNames).toContain("browser_open");
    expect(toolNames).not.toContain("demo_record");
    expect(toolNames).not.toContain("message_send");
    expect(toolNames).not.toContain("order_place");
  });

  it("докрутка вывода: stop_reason=max_tokens → продолжает с места обрыва и склеивает (не огрызок)", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider([
      { text: "Часть один.", stopReason: "max_tokens" },
      { text: " Часть два.", stopReason: "max_tokens" },
      { text: " Конец." }, // end_turn
    ]);
    const reply = await handleUserText(session, "напиши длинный текст", await makeDeps(llm));
    expect(reply.voice).toContain("Часть один.");
    expect(reply.voice).toContain("Часть два.");
    expect(reply.voice).toContain("Конец."); // склеено, а не оборвано на первом ходе
    expect(llm.requests).toHaveLength(3); // 2 докрутки + финал
    // 2-й запрос содержит нудж продолжения последним user-сообщением
    const msgs2 = llm.requests[1]?.messages ?? [];
    const lastUser = [...msgs2].reverse().find((m) => m.role === "user");
    expect(JSON.stringify(lastUser?.content)).toContain("Продолжай ровно с места обрыва");
  });

  it("докрутка ограничена капом MAX_CONTINUATIONS (анти-runaway, не зацикливается)", async () => {
    const session = fakeSession();
    const turns = Array.from({ length: 30 }, (_, i) => ({ text: `ч${i} `, stopReason: "max_tokens" as const }));
    const llm = new MockLlmProvider(turns);
    await handleUserText(session, "бесконечный текст", await makeDeps(llm));
    // деф кап 6 → 1 первый ход + ≤6 докруток; точно не все 30 и не вечный цикл
    expect(llm.requests.length).toBeGreaterThanOrEqual(2);
    expect(llm.requests.length).toBeLessThanOrEqual(8);
  });

  it("§20 правка на ходу: реплика-правка при АКТИВНОЙ задаче → впрыск в неё, НЕ вторая петля", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider();
    const tasks = new TaskManager();
    const task = tasks.create({ userId: "u1", sessionId: "s1", goal: "сделать таблицу расходов" });
    const reply = await handleUserText(session, "нет, не то, переделай", await makeDeps(llm, { tasks }));
    expect(llm.requests).toHaveLength(0); // не плодим новую петлю/вызов LLM
    expect(task.steer.pending).toHaveLength(1); // правка ушла В активную задачу
    expect(task.steer.pending[0]).toMatch(/переделай/);
    expect(reply.voice.toLowerCase()).toMatch(/поправляю|принял/); // короткое подтверждение
  });

  it("§20 правка впрыскивается в ИДУЩУЮ петлю: следующий запрос к LLM содержит ПОПРАВКУ", async () => {
    // Провайдер на 1-м шаге кладёт правку в активную задачу; петля должна слить её ПЕРЕД 2-м шагом.
    class SteerOnFirstStep extends MockLlmProvider {
      constructor(private mgr: TaskManager, private sid: string, script: ConstructorParameters<typeof MockLlmProvider>[0]) {
        super(script);
      }
      override async complete(req: Parameters<MockLlmProvider["complete"]>[0]): ReturnType<MockLlmProvider["complete"]> {
        if (this.requests.length === 0) {
          const t = this.mgr.active(this.sid);
          if (t) this.mgr.steer(t.taskId, "сделай вместо этого иначе");
        }
        return super.complete(req);
      }
    }
    const session = fakeSession();
    const tasks = new TaskManager();
    const llm = new SteerOnFirstStep(tasks, "s1", [
      { toolUses: [{ id: "t0", name: "app_launch", input: { app: "блокнот" } }] },
      { text: "Готово." },
    ]);
    await handleUserText(session, "сделай долгую задачу с шагами", await makeDeps(llm, { tasks }));
    expect(llm.requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(llm.requests[1])).toContain("ПОПРАВКА"); // правка дошла до модели на 2-м шаге
  });

  it("§трейдинг: биржевой инструмент в ходе → следующий запрос на МАКС модели (Opus), без тиров", async () => {
    const session = fakeSession();
    // вход НЕ биржевой по лексике → роутер даёт sonnet («s»); market_analyze в ходе → эскалация на fable («f»)
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "m0", name: "market_analyze", input: { symbol: "SBER" } }] },
      { text: "Готово." },
    ]);
    await handleUserText(session, "глянь-ка по одной штуке", await makeDeps(llm));
    expect(llm.requests.length).toBeGreaterThanOrEqual(2);
    expect(llm.requests[0]?.model).toBe("s"); // первый ход — слабый тир
    expect(llm.requests[1]?.model).toBe("f"); // после биржевого инструмента — макс модель
  });

  it("anti-runaway по СЕМЕЙСТВУ: флуд одного инструмента (РАЗНЫЙ input) → нудж, затем обрыв (не до max_steps)", async () => {
    process.env.JARVIS_TOOL_FAMILY_CAP = "3"; // порог 3 для быстрого теста (MAX_FAMILY_NUDGES=1 → обрыв на 6)
    const session = fakeSession();
    // 20× ОДИН инструмент с РАЗНЫМ input — identicalRepeats (байт-в-байт) НЕ ловит; ловит детектор семейства.
    const turns = Array.from({ length: 20 }, (_, i) => ({ toolUses: [{ id: `t${i}`, name: "web_inspect", input: { q: `q${i}` } }] }));
    const llm = new MockLlmProvider(turns);
    await handleUserText(session, "поковыряйся на сайте", await makeDeps(llm));
    delete process.env.JARVIS_TOOL_FAMILY_CAP;
    expect(llm.requests.length).toBeLessThan(10); // оборвалось сильно раньше 20/50 (max_steps)
    expect(JSON.stringify(llm.requests)).toContain("топтание"); // интервент-нудж «смени подход» ушёл модели
  });

  it("анти-капитуляция: текст-отказ БЕЗ единого инструмента → нудж на попытку, затем инструмент (не сдаётся)", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider([
      { text: "Боюсь, я пока не умею это, сэр.", stopReason: "end_turn" }, // капитуляция, 0 инструментов
      { toolUses: [{ id: "t1", name: "web_search", input: { query: "как сделать" } }] }, // после нуджа — попытка
      { text: "Разобрался — готово." }, // финал
    ]);
    const reply = await handleUserText(session, "сделай мне отчёт по продажам", await makeDeps(llm));
    expect(llm.requests).toHaveLength(3); // отказ → нудж → инструмент → финал (не принял отказ как финал)
    expect(JSON.stringify(llm.requests[1]?.messages ?? [])).toContain("запрещённый ответ"); // нудж «не могу=запрещено» ушёл моделью
    expect(reply.voice).toContain("Разобрался"); // финал, а НЕ исходная капитуляция
    expect(reply.voice.toLowerCase()).not.toContain("не умею"); // отказ не просочился в финал
  });

  it("анти-капитуляция: сдался СЛОВАМИ ПОСЛЕ провального инструмента (traj>0, ноль успехов) → тоже нудж", async () => {
    // sendAction возвращает провал → клиентский инструмент падает (isError), anyToolSucceeded=false.
    const sendAction = vi.fn(() =>
      Promise.resolve({ commandId: "c", ok: false, error: { code: "denied", detail: "USER_BUSY" }, durationMs: 1 }),
    );
    const session = fakeSession(sendAction);
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "app_launch", input: { app: "x" } }] }, // → sendAction провал → ошибка
      { text: "Не вышло, сэр, не могу.", stopReason: "end_turn" }, // капитуляция ПОСЛЕ провала — раньше НЕ ловилась
      { toolUses: [{ id: "t2", name: "web_search", input: { query: "способ" } }] }, // после нуджа — другая попытка
      { text: "Разобрался — готово.", stopReason: "end_turn" }, // терминал без сверки глазами → goal-гейт
      { text: "Разобрался — цель достигнута." }, // подтверждение после goal-гейта (§адаптация к цели)
    ]);
    const reply = await handleUserText(session, "сделай это", await makeDeps(llm));
    expect(llm.requests).toHaveLength(5); // провал → отказ → НУДЖ → инструмент → [goal-гейт] → финал
    expect(JSON.stringify(llm.requests[4]?.messages ?? [])).toContain("ИСХОДНОЙ"); // goal-гейт ушёл модели
    expect(reply.voice).toContain("Разобрался");
    expect(reply.voice.toLowerCase()).not.toContain("не могу"); // капитуляция не просочилась
  });

  it("анти-капитуляция: НЕ трогает остроумную отбивку абсурда (нудж не зацикливает характер)", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider([{ text: "Боюсь, баллистика ракеты не в моём репертуаре, сэр.", stopReason: "end_turn" }]);
    const reply = await handleUserText(session, "ударь ракетой по луне", await makeDeps(llm));
    expect(llm.requests).toHaveLength(1); // нудж НЕ сработал (исключение опасного/абсурда) → один ход
    expect(reply.voice).toContain("репертуаре");
  });

  it("verify-петля P0.2: слепое действие (input_key) → нейтральное «Готово» БЕЗ слов-маркеров → форсит сверку, не врёт", async () => {
    // sendAction отдаёт картинку для screen.capture (иначе lookAtScreen вернёт ошибку); input.key игнорит data.
    const sendAction = vi.fn(() =>
      Promise.resolve({ commandId: "c", ok: true, durationMs: 1, data: { image: "QUFB", mediaType: "image/png" } }),
    );
    const session = fakeSession(sendAction);
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "input_key", input: { keys: "Space" } }] }, // слепое действие, ok
      { text: "Готово, поставил на паузу.", stopReason: "end_turn" }, // нет «вижу/результат» → старый regex-триггер молчал
      { toolUses: [{ id: "t2", name: "screen_capture", input: {} }] }, // после нуджа — сверка глазами
      { text: "Подтверждаю: воспроизведение остановлено." }, // финал после сверки
    ]);
    const reply = await handleUserText(session, "сделай мне отчёт по продажам", await makeDeps(llm));
    expect(llm.requests).toHaveLength(4); // действие → [verify-нудж] → сверка → финал (раньше принял бы «Готово» сразу)
    expect(JSON.stringify(llm.requests[2]?.messages ?? [])).toContain("СВЕРЬ"); // нудж на сверку ушёл модели
    expect(reply.voice).toContain("Подтверждаю");
  });

  it("verify-петля P0.2: самоподтверждающийся mutate (app_launch) → сверку НЕ форсит (исход уже в результате)", async () => {
    const session = fakeSession(); // sendAction ok по умолчанию
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "app_launch", input: { app: "calc" } }] }, // mutate, но НЕ слепой
      { text: "Готово, запустил калькулятор.", stopReason: "end_turn" }, // финал — без лишней сверки
    ]);
    const reply = await handleUserText(session, "сделай мне сводку", await makeDeps(llm));
    expect(llm.requests).toHaveLength(2); // действие → финал, БЕЗ паразитного verify-нуджа на код-ран/запуск
    expect(reply.voice).toContain("калькулятор");
  });

  it("анти-капитуляция P0.1: успешный НЕЙТРАЛЬНЫЙ поиск + сдался словами → всё равно нудж (поиск ≠ «сделал»)", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "web_search", input: { query: "способ" } }] }, // нейтральный успех
      { text: "Боюсь, дальше не могу, сэр.", stopReason: "end_turn" }, // раньше anyToolSucceeded=true глушил нудж
      { toolUses: [{ id: "t2", name: "app_launch", input: { app: "x" } }] }, // после нуджа — реальная попытка (mutate)
      { text: "Готово, сделал через приложение.", stopReason: "end_turn" }, // терминал без сверки → goal-гейт
      { text: "Сделал, цель достигнута." }, // подтверждение после goal-гейта (§адаптация к цели)
    ]);
    const reply = await handleUserText(session, "сделай эту работу", await makeDeps(llm));
    expect(llm.requests).toHaveLength(5); // поиск → отказ → НУДЖ → действие → [goal-гейт] → финал
    expect(reply.voice.toLowerCase()).not.toContain("не могу"); // капитуляция не просочилась в финал
  });

  it("masked-failure P0.1: только нейтральный поиск + пустое «Готово» → честный провал (не врёт «готово»)", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "web_search", input: { query: "x" } }] }, // нейтральный успех, дело НЕ сделано
      { text: "Готово.", stopReason: "end_turn" }, // пустое подтверждение
    ]);
    const reply = await handleUserText(session, "сделай задачу для меня", await makeDeps(llm));
    expect(reply.voice.toLowerCase()).not.toContain("готово"); // раньше anyToolSucceeded=true пропускал ложное «Готово»
    expect(reply.voice.toLowerCase()).toMatch(/не вышло|не сработал/);
  });

  it("§20 дубль-гейт: повтор фразы активной задачи НЕ плодит вторую петлю («Уже делаю»)", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider();
    const tasks = new TaskManager();
    tasks.create({ userId: "u1", sessionId: "s1", goal: "напиши реферат про флот" }); // идёт (running)
    const reply = await handleUserText(session, "напиши реферат про флот", await makeDeps(llm, { tasks }));
    expect(reply.voice).toContain("Уже делаю"); // живой случай: «продолжи/продолжу» ×2 = две задачи, «остановил» ×2
    expect(llm.requests).toHaveLength(0); // вторая петля не запускалась
    expect(tasks.list("u1")).toHaveLength(1); // задача одна
  });

  it("§20 дубль-гейт (эпизод 2026-07-10): STT-обрывок повтора («в dot'е.») НЕ плодит вторую петлю", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider();
    const tasks = new TaskManager();
    tasks.create({ userId: "u1", sessionId: "s1", goal: "запусти поиск в доте." }); // идёт (running)
    const reply = await handleUserText(session, "в dot'е.", await makeDeps(llm, { tasks }));
    expect(reply.voice).toContain("Уже делаю"); // живой каскад: обрывок → вторая задача → обе убиты потолком
    expect(llm.requests).toHaveLength(0);
    expect(tasks.list("u1")).toHaveLength(1);
  });

  it("§20 реджект-повтор («нет, не то — …та же цель») — это STEER (правка), а не «Уже делаю»", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider();
    const tasks = new TaskManager();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "запусти поиск в доте." });
    const reply = await handleUserText(session, "нет, не то — запусти поиск в доте", await makeDeps(llm, { tasks }));
    expect(reply.voice).toContain("поправляю"); // рулёжка недовольного → впрыск в идущую задачу
    expect(t.steer.pending).toHaveLength(1); // поправка легла в очередь петли
    expect(llm.requests).toHaveLength(0);
  });

  it("живой смоук 2026-07-02: ВОПРОС + нейтральный tool + пустой финал → нудж на ответ, НЕ «Не вышло»", async () => {
    const session = fakeSession();
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "memory_search", input: { query: "2+2" } }] }, // нейтральный успех
      { text: "" }, // модель «ответила» в отброшенной преамбуле tool-раунда → финал пустой
      { text: "Четыре, сэр." }, // после нуджа — содержательный ответ
    ]);
    const reply = await handleUserText(session, "сколько будет два плюс два?", await makeDeps(llm, { tasks }));
    const nudged = llm.requests.some((r) => JSON.stringify(r.messages ?? []).includes("БЕЗ финальной реплики"));
    expect(nudged).toBe(true);
    expect(reply.voice).toContain("Четыре"); // ответ дошёл, а не «Не вышло, сэр — действие не сработало»
    expect(tasks.list("u1")[0]?.state).toBe("done"); // вопрос не помечен провалом
  });

  it("консьерж: голая команда-сервис → быстрый вопрос (без LLM), ответ → действие", async () => {
    const session = fakeSession();
    const deps = await makeDeps(new MockLlmProvider());
    // 1) «Джарвис, ютуб» → мгновенный вопрос, БЕЗ действия и БЕЗ LLM, висит уточнение
    const q = await handleUserText(session, "Джарвис, ютуб", deps);
    expect(q.voice).toMatch(/рекомендац/i);
    expect(session.sendAction).not.toHaveBeenCalled();
    expect((deps.llm as MockLlmProvider).requests).toHaveLength(0);
    expect(deps.pendingClarify?.key).toBe("youtube");
    // 2) ответ «рекомендации» → tier0 действие browser.open, уточнение снято, LLM не звался
    await handleUserText(session, "рекомендации", deps);
    expect(session.sendAction).toHaveBeenCalledTimes(1);
    // inDefault:true → открыть в ТВОЁМ дефолтном (залогиненном) браузере через shell, НЕ CDP-инстанс
    // и НЕ синтетический ввод → физическую мышь не трогаем, сессия/логин на месте.
    expect(session.sendAction.mock.calls[0]?.[0]).toMatchObject({ kind: "browser.open", inDefault: true });
    expect(deps.pendingClarify).toBeUndefined();
    expect((deps.llm as MockLlmProvider).requests).toHaveLength(0);
  });

  it("консьерж: невпопад-ответ снимает уточнение и маршрутизируется обычно", async () => {
    const session = fakeSession();
    const deps = await makeDeps(new MockLlmProvider([{ text: "Сейчас гляну." }]));
    await handleUserText(session, "ютуб", deps); // повис вопрос
    expect(deps.pendingClarify?.key).toBe("youtube");
    await handleUserText(session, "какая погода завтра", deps); // не ответ → обычный путь (LLM)
    expect(deps.pendingClarify).toBeUndefined();
    expect((deps.llm as MockLlmProvider).requests.length).toBeGreaterThanOrEqual(1);
  });

  it("расширение подключено → открытие через openOrFocus (фокус вкладки), БЕЗ shell/CDP", async () => {
    const session = fakeSession();
    const openOrFocus = vi.fn(async () => ({ focused: true })); // вкладка уже была → фокус
    const deps = await makeDeps(new MockLlmProvider(), { openOrFocus });
    await handleUserText(session, "ютуб", deps); // вопрос
    const r = await handleUserText(session, "рекомендации", deps); // ответ → открытие
    expect(openOrFocus).toHaveBeenCalledWith("https://youtube.com");
    expect(session.sendAction).not.toHaveBeenCalled(); // НЕ дублируем вкладку через shell/CDP
    expect(r.voice).toMatch(/переключ/i); // focused → «переключился», а не «открыл»
  });

  it("расширение НЕ подключено (openOrFocus reject) → откат на shell-open", async () => {
    const session = fakeSession();
    const openOrFocus = vi.fn(async () => {
      throw new Error("расширение не подключено");
    });
    const deps = await makeDeps(new MockLlmProvider(), { openOrFocus });
    await handleUserText(session, "ютуб", deps);
    await handleUserText(session, "рекомендации", deps);
    expect(openOrFocus).toHaveBeenCalled();
    expect(session.sendAction).toHaveBeenCalledTimes(1); // откат: shell-open в дефолтный браузер
    expect(session.sendAction.mock.calls[0]?.[0]).toMatchObject({ kind: "browser.open", inDefault: true });
  });

  it("actuator tool из петли → session.sendAction", async () => {
    const session = fakeSession();
    const deps = await makeDeps(
      new MockLlmProvider([
        { toolUses: [{ id: "t1", name: "app_launch", input: { app: "calc" } }] },
        { text: "Открыл калькулятор." },
      ]),
    );
    await handleUserText(session, "посчитай что-нибудь сложное и многошаговое", deps);
    const cmd = session.sendAction.mock.calls[0]?.[0];
    expect(cmd?.kind).toBe("app.launch");
    expect((cmd as { app: string }).app).toBe("calc");
  });

  it("предохранитель: лимит шагов останавливает петлю (§14)", async () => {
    const session = fakeSession();
    // Модель всегда просит инструмент → без лимита петля бесконечна.
    const llm = new MockLlmProvider(
      Array.from({ length: 10 }, () => ({
        toolUses: [{ id: "t", name: "memory_search", input: { query: "x" } }],
      })),
    );
    const deps = await makeDeps(llm, { spend: new SpendGuard({ maxStepsPerTask: 2 }) });
    const reply = await handleUserText(session, "сделай что-то бесконечное и сложное", deps);
    expect(reply.voice.toLowerCase()).toContain("лимит");
    expect(llm.requests.length).toBeLessThanOrEqual(3);
  });

  it("anti-runaway: повтор ОДНОГО успешного действия → петля обрывается, не «до посинения»", async () => {
    const session = fakeSession(); // sendAction по умолчанию успешен
    const llm = new MockLlmProvider(
      Array.from({ length: 8 }, () => ({ toolUses: [{ id: "t", name: "app_launch", input: { app: "x" } }] })),
    );
    const reply = await handleUserText(session, "сделай что-то многошаговое", await makeDeps(llm));
    // H4: на 3-м одинаковом — нудж (сверься/смени подход), на 4-м — обрыв. Не все 8 раундов.
    expect(llm.requests.length).toBeLessThanOrEqual(4);
    expect(reply.voice.trim().length).toBeGreaterThan(0);
  });

  it("H4: топтание на одном действии → нудж «смени подход», при упорстве — честный провал (не «Готово»)", async () => {
    const session = fakeSession(); // sendAction успешен → повторы «успешные»
    const tasks = new TaskManager();
    const llm = new MockLlmProvider(
      Array.from({ length: 8 }, () => ({ toolUses: [{ id: "t", name: "app_launch", input: { app: "x" } }] })),
    );
    const reply = await handleUserText(session, "сделай что-то многошаговое", await makeDeps(llm, { tasks }));
    // Нудж ушёл модели (в user-сообщении с tool_result), и терминал честный: провал, не «Готово, сэр.».
    const nudged = llm.requests.some((r) => JSON.stringify(r.messages ?? []).includes("ОДНО И ТО ЖЕ"));
    expect(nudged).toBe(true);
    expect(reply.voice.toLowerCase()).not.toContain("готово");
    expect(tasks.list("u1")[0]?.state).toBe("failed"); // на «сделал?» не соврёт done
  });

  it("H2: аварийный стаб LLM → честный провал задачи, стаб-текст не финалит успехом", async () => {
    const session = fakeSession();
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { text: "Связь с сервером прервалась, сэр. Повторите, пожалуйста.", stopReason: "stub" },
    ]);
    const reply = await handleUserText(session, "разберись с одной штукой", await makeDeps(llm, { tasks }));
    expect(reply.voice.toLowerCase()).toContain("связь");
    expect(tasks.list("u1")[0]?.state).toBe("failed"); // раньше: done + ok=true в метриках
  });

  it("H2: стаб НЕ отравляет семантический кэш («заевшая пластинка» ошибки связи)", async () => {
    const session = fakeSession();
    const store = vi.fn(async () => {});
    const responseCache = { lookup: vi.fn(async () => null), store } as unknown as AgentDeps["responseCache"];
    const llm = new MockLlmProvider([
      { text: "Связь с сервером прервалась, сэр. Повторите, пожалуйста.", stopReason: "stub" },
    ]);
    await handleUserText(session, "разберись с одной штукой", await makeDeps(llm, { responseCache }));
    expect(store).not.toHaveBeenCalled(); // повтор вопроса пойдёт в ЖИВОЙ LLM, а не в кэш с ошибкой
  });

  it("goal-check: финал «запущена» ПОСЛЕ verify-раунда всё равно сверяется с целью (живой случай «поиск в доте»)", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "app_launch", input: { app: "dota 2" } }] },
      { toolUses: [{ id: "t2", name: "web_read", input: { url: "https://example.com" } }] }, // сверка глазами ок
      { text: "Дота запущена, сэр — процесс поднялся." }, // подцель (запуск), не цель (поиск матча)
      { text: "Поиск матча включён, подтверждаю." },
    ]);
    await handleUserText(session, "запусти поиск матча в доте", await makeDeps(llm));
    // Раньше lastRoundHadVerify гасил goal-check → ложный done на подцели. Теперь сверка с ИСХОДНОЙ целью.
    expect(llm.requests).toHaveLength(4);
    expect(JSON.stringify(llm.requests[3]?.messages ?? [])).toContain("ИСХОДНОЙ");
  });

  it("H3: «прочитал и сдался словами» ловится анти-капитуляцией (fs_read больше не «дело сделано»)", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "fs_read", input: { path: "C:/x.txt" } }] }, // чтение ок (neutral)
      { text: "Не могу это сделать, сэр." }, // капитуляция после ОДНОГО чтения
      { toolUses: [{ id: "t2", name: "fs_edit", input: { path: "C:/x.txt", find: "a", replace: "b" } }] }, // дело
      { text: "Сделал: заменил строку и сохранил файл." },
      { text: "Готово: правка на месте." }, // ответ на goal-check (сверка с исходной целью)
    ]);
    const reply = await handleUserText(session, "поправь строку в файле и сохрани", await makeDeps(llm));
    // Раньше fs_read (mutate по дефолту) взводил anyMutateSucceeded → отказ принимался финалом.
    const nudged = llm.requests.some((r) => JSON.stringify(r.messages ?? []).includes("СТОП. Ты НЕ говоришь"));
    expect(nudged).toBe(true);
    expect(reply.voice).toContain("правка на месте");
  });

  it("M8 §20: стримит task.status running → done на многошаговой задаче", async () => {
    const tasks = new TaskManager();
    const statuses: TaskStatus[] = [];
    const send = vi.fn((type: string, payload: unknown) => {
      if (type === "task.status") statuses.push(payload as TaskStatus);
    });
    const sendAction = vi.fn(() => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 }));
    const session = { sessionId: "s1", userId: "u1", sendAction, send } as unknown as Session;
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "memory_search", input: { query: "зал" } }] },
      { text: "Посмотрел, готово." },
    ]);
    await handleUserText(session, "что у меня в памяти про зал, разверни", await makeDeps(llm, { tasks }));

    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(statuses.some((s) => s.state === "running")).toBe(true);
    expect(statuses[statuses.length - 1]?.state).toBe("done");
    expect(tasks.list("u1")[0]?.state).toBe("done");
  });

  it("§7: модель застряла (инструменты падают подряд) → авто-эскалация тира sonnet→fable", async () => {
    // sendAction всегда падает → actuator-инструменты возвращают ошибку. Команда-действие
    // («разберись…») теперь по дефолту идёт в sonnet (роутер инвертирован) → эскалация sonnet→fable.
    const failingSend = vi.fn(() =>
      Promise.resolve({ commandId: "c", ok: false, error: { code: "runtime" as const, message: "fail" }, durationMs: 1 }),
    );
    const session = fakeSession(failingSend);
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "app_launch", input: { app: "x" } }] }, // раунд 1 — ошибка
      { toolUses: [{ id: "t2", name: "app_launch", input: { app: "x" } }] }, // раунд 2 — ошибка → эскалация
      { toolUses: [{ id: "t3", name: "app_launch", input: { app: "x" } }] }, // уже на fable
      { text: "Зашёл с другой стороны, готово." },
    ]);
    await handleUserText(session, "разберись с одной штукой", await makeDeps(llm));
    const models = llm.requests.map((r) => r.model);
    expect(models[0]).toBe("s"); // начали на sonnet (дефолт для команды-действия)
    expect(models).toContain("f"); // после 2 провалов подряд — эскалация на fable
  });

  it("§7: haiku-трёп тоже эскалирует при провалах (haiku→sonnet)", async () => {
    // Явный трёп идёт в haiku; если на нём вдруг пошли падающие инструменты — лестница haiku→sonnet.
    const failingSend = vi.fn(() =>
      Promise.resolve({ commandId: "c", ok: false, error: { code: "runtime" as const, message: "fail" }, durationMs: 1 }),
    );
    const session = fakeSession(failingSend);
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "app_launch", input: { app: "x" } }] },
      { toolUses: [{ id: "t2", name: "app_launch", input: { app: "x" } }] },
      { toolUses: [{ id: "t3", name: "app_launch", input: { app: "x" } }] },
      { text: "Готово." },
    ]);
    await handleUserText(session, "привет, как дела", await makeDeps(llm));
    const models = llm.requests.map((r) => r.model);
    expect(models[0]).toBe("h"); // трёп начали на haiku
    expect(models).toContain("s"); // провалы подряд → эскалация на sonnet
  });

  it("§20 async: задача-действие → тихий финал + результат в фоне (не блокирует, без дубль-ack)", async () => {
    const session = fakeSession();
    const spoken: { voice: string }[] = [];
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "app_launch", input: { app: "calc" } }] },
      { text: "Готово, калькулятор открыт, сэр." },
    ]);
    const deps = await makeDeps(llm, { speakResult: (r) => spoken.push(r) });
    // «создай …» → sonnet → фон
    const reply = await handleUserText(session, "создай файл и посчитай что-нибудь сложное", deps);
    expect(reply.voice).toBe(""); // §20 тихий финал: без немедленного ack (фраза будет одна — результат)
    expect(spoken).toHaveLength(0); // результат ещё не готов — разговор не блокирован
    await vi.waitFor(() => expect(spoken.length).toBeGreaterThan(0), { timeout: 3000 });
    expect(spoken[0]?.voice).toContain("калькулятор"); // итог проговорён в фоне (единственная фраза хода)
  });

  it("§6/§20: waitWhilePaused ждёт пока paused и продолжает после resume", async () => {
    const task = { state: "paused", cancel: { cancelled: false } } as Task;
    const p = waitWhilePaused(task);
    let done = false;
    void p.then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 60));
    expect(done).toBe(false); // на паузе — петля стоит, не продолжает
    task.state = "running"; // resume (router/takeover)
    await p;
    expect(done).toBe(true);
  });

  it("§6/§20: waitWhilePaused выходит сразу при отмене на паузе", async () => {
    const task = { state: "paused", cancel: { cancelled: false } } as Task;
    const p = waitWhilePaused(task);
    task.cancel.cancelled = true; // отмена во время паузы
    await p; // не должно зависнуть
    expect(true).toBe(true);
  });

  it("Б4 (г): waitForChannel возвращает true, когда канал восстановился", async () => {
    const task = { cancel: { cancelled: false } } as Task;
    let up = false;
    const session = { channelUp: () => up };
    const p = waitForChannel(session, 5_000, task, async () => { up = true; }, () => Date.now());
    expect(await p).toBe(true); // после первого sleep канал ожил
  });

  it("Б4 (г): waitForChannel возвращает false по таймауту (канал не вернулся)", async () => {
    const task = { cancel: { cancelled: false } } as Task;
    let t = 0;
    const session = { channelUp: () => false };
    const res = await waitForChannel(session, 1_000, task, async () => { t += 300; }, () => t);
    expect(res).toBe(false); // окно вышло, канал так и не поднялся
  });

  it("Б4 (г): waitForChannel выходит при отмене задачи", async () => {
    const task = { cancel: { cancelled: false } } as Task;
    const session = { channelUp: () => false };
    const p = waitForChannel(session, 60_000, task, async () => { task.cancel.cancelled = true; }, () => Date.now());
    expect(await p).toBe(false); // отмена прервала ожидание, не зависли
  });

  it("§8 HERMES: recall подбирает навык и вшивает его процедуру в системный промпт", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider([{ text: "Готово." }]);
    const recall = vi.fn(async () => ({
      id: "tg-report",
      ownerId: "u-1",
      name: "Отчёт в Telegram",
      when: "прислать отчёт в телеграм",
      procedure: "1. собрать данные\n2. отправить через telegram_send",
      version: 2,
    }));
    const deps = await makeDeps(llm, { skills: fakeSkills({ recall }) });
    await handleUserText(session, "пришли отчёт в телеграм", deps);
    expect(recall).toHaveBeenCalled();
    // §15-фикс: навык вшивается в КЕШИРУЕМЫЙ systemSkill (свой брейкпоинт), а НЕ в некешируемую
    // динамику — чтобы на повторных ходах задачи он читался из кеша, а не слался заново.
    const skill = llm.requests[0]?.systemSkill ?? "";
    expect(skill).toContain("Отчёт в Telegram"); // имя навыка попало в промпт
    expect(skill).toContain("отправить через telegram_send"); // процедура вшита
    expect(llm.requests[0]?.systemDynamic ?? "").not.toContain("telegram_send"); // НЕ в динамике
  });

  it("§8 МАКРОС: recall со steps-реплеем → skill.execute уходит клиенту ДО LLM, модели — нудж на сверку", async () => {
    const sendAction = vi.fn(() =>
      Promise.resolve({ commandId: "c", ok: true, durationMs: 5, data: { image: "QUFB", mediaType: "image/png" } }),
    );
    const session = fakeSession(sendAction);
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "screen_capture", input: {} }] }, // сверка глазами после реплея
      { text: "Подтверждаю: поиск запущен." },
    ]);
    const recall = vi.fn(async () => ({
      id: "learned__dota-search",
      ownerId: "u-1",
      name: "Поиск в доте",
      when: "запустить поиск матча",
      procedure: "проза процедуры",
      version: 4,
      steps: [
        { action: "app.focus", params: { app: "dota2" } },
        { action: "wait", params: { ms: "500" } },
        { action: "input.click", target: { by: "coords" as const, x: 2100, y: 1200, space: "screen" as const }, params: { method: "physical" } },
      ],
      needsReview: false,
    }));
    const deps = await makeDeps(llm, { skills: fakeSkills({ recall }) });
    const reply = await handleUserText(session, "запусти поиск в доте", deps);
    // Реплей ушёл ПЕРВОЙ командой (до любого LLM-вызова): kind=skill.execute с шагами навыка.
    const calls = sendAction.mock.calls as unknown as Array<[{ kind?: string; skillId?: string; steps?: unknown[] }]>;
    const first = calls[0]?.[0];
    expect(first?.kind).toBe("skill.execute");
    expect(first?.skillId).toBe("learned__dota-search");
    expect(first?.steps).toHaveLength(3);
    // Модель получила нудж «макрос отработал — сверь глазами», а не команду делать шаги заново.
    expect(JSON.stringify(llm.requests[0]?.messages ?? [])).toContain("Авто-макрос");
    expect(reply.voice).toContain("Подтверждаю");
  });

  it("§8 МАКРОС: guard-шаги в реплее (needsReview) → быстрый путь НЕ запускается", async () => {
    const sendAction = vi.fn(() =>
      Promise.resolve({ commandId: "c", ok: true, durationMs: 5, data: { image: "QUFB", mediaType: "image/png" } }),
    );
    const session = fakeSession(sendAction);
    const llm = new MockLlmProvider([{ text: "Хорошо, сэр." }]);
    const recall = vi.fn(async () => ({
      id: "learned__risky",
      ownerId: "u-1",
      name: "Рискованный",
      when: "что-то необратимое",
      procedure: "проза",
      version: 1,
      steps: [
        { action: "input.click", target: { by: "coords" as const, x: 1, y: 2, space: "screen" as const } },
        { action: "input.key", params: { combo: "enter" } },
      ],
      needsReview: true, // guard → авто-прогон запрещён (§14)
    }));
    const deps = await makeDeps(llm, { skills: fakeSkills({ recall }) });
    await handleUserText(session, "сделай необратимое", deps);
    const kinds = (sendAction.mock.calls as unknown as Array<[{ kind?: string }]>).map((c) => c[0]?.kind);
    expect(kinds).not.toContain("skill.execute"); // реплей не гнали
  });

  it("§8 HERMES: после сложной задачи без навыка — бэкстоп предлагает сохранить (skill_save)", async () => {
    const session = fakeSession();
    // 3 tool-use раунда + финал → задача «сложная»; затем рефлексия зовёт skill_save.
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "1", name: "web_search", input: { query: "x" } }] },
      { toolUses: [{ id: "2", name: "web_open", input: { url: "https://x" } }] },
      { toolUses: [{ id: "3", name: "web_read", input: {} }] },
      { text: "Готово, сделал." },
      { toolUses: [{ id: "s", name: "skill_save", input: { name: "Навык", when: "когда", procedure: "шаги" } }] },
      { text: "Сохранил." },
    ]);
    const save = vi.fn(async (_u: string, input: { name: string }) => ({ id: "n", name: input.name, version: 1 }));
    const deps = await makeDeps(llm, { skills: fakeSkills({ save }) });
    await handleUserText(session, "сделай сложную многошаговую задачу", deps);
    expect(save).toHaveBeenCalled(); // приём сохранён бэкстопом самообучения
  });

  it("§8 HERMES: задача ПРОВАЛИЛАСЬ (все инструменты с ошибкой) — навык НЕ сохраняем", async () => {
    // sendAction всегда падает → actuator-инструменты возвращают ошибку; finalText всё равно
    // выставится (модель «сдалась» текстом), но это НЕ успех — бэкстоп не должен сработать.
    const failingSend = vi.fn(() =>
      Promise.resolve({ commandId: "c", ok: false, error: { code: "runtime" as const, message: "fail" }, durationMs: 1 }),
    );
    const session = fakeSession(failingSend);
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "1", name: "app_launch", input: { app: "x" } }] },
      { toolUses: [{ id: "2", name: "app_launch", input: { app: "x" } }] },
      { toolUses: [{ id: "3", name: "app_launch", input: { app: "x" } }] },
      { text: "Не смог, извините." },
    ]);
    const save = vi.fn();
    const deps = await makeDeps(llm, { skills: fakeSkills({ save }) });
    await handleUserText(session, "сделай сложную многошаговую задачу", deps);
    expect(save).not.toHaveBeenCalled(); // из проваленной задачи «приём» не выучиваем
  });

  it("§8 HERMES: если навык применён (recall сработал) — бэкстоп НЕ навязывает сохранение", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "1", name: "web_search", input: { query: "x" } }] },
      { toolUses: [{ id: "2", name: "web_open", input: { url: "https://x" } }] },
      { toolUses: [{ id: "3", name: "web_read", input: {} }] },
      { text: "Готово." },
    ]);
    const save = vi.fn();
    const recall = vi.fn(async () => ({ id: "k", ownerId: "u-1", name: "К", when: "сложная задача", procedure: "шаги", version: 1 }));
    const deps = await makeDeps(llm, { skills: fakeSkills({ save, recall }) });
    await handleUserText(session, "сделай сложную многошаговую задачу по навыку", deps);
    expect(recall).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled(); // навык уже был — не плодим дубликат
  });

  it("M8 §20: отмена в петле останавливает задачу (≤1 шага), state cancelled", async () => {
    const tasks = new TaskManager();
    // Имитируем приход task.control(cancel): как только пришёл прогресс — отменяем задачу.
    const send = vi.fn((type: string, payload: unknown) => {
      const s = payload as TaskStatus;
      if (type === "task.status" && s.state === "running" && (s.stepsDone ?? 0) >= 1) {
        tasks.cancel(s.taskId);
      }
    });
    const sendAction = vi.fn(() => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 }));
    const session = { sessionId: "s1", userId: "u1", sendAction, send } as unknown as Session;
    // Модель всё время просит инструмент — петля бесконечна, остановит только отмена.
    const llm = new MockLlmProvider(
      Array.from({ length: 10 }, () => ({
        toolUses: [{ id: "t", name: "memory_search", input: { query: "x" } }],
      })),
    );
    const reply = await handleUserText(session, "сделай долгую многошаговую работу", await makeDeps(llm, { tasks }));

    // Терминал отмены ТИХИЙ (аудит 2026-07-02): ack «Остановил.» произносит handleTaskControl ОДИН раз
    // на команду; петля не дублирует его (иначе на N задачах — N голосов). Здесь control-хендлер не
    // вызывается (отмена имитируется напрямую), поэтому голос пустой.
    expect(reply.voice).toBe("");
    expect(tasks.list("u1")[0]?.state).toBe("cancelled");
    // Отмена ≤1 шага: после прогресса №1 петля не успевает уйти далеко.
    expect(llm.requests.length).toBeLessThanOrEqual(3);
  });
});

/** Не-стабовый скриптовый LLM: MockLlmProvider всегда stubbed:true → префилл честно отменяется,
 *  а для теста «префилл ЗАПОЛНИЛ и гард перепроверил» нужен живой ответ. */
function scriptedLlm(texts: string[]): ILlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  let i = 0;
  const self = {
    live: false,
    requests,
    complete: async (req: LlmRequest) => {
      requests.push(req);
      const text = texts[Math.min(i, texts.length - 1)] ?? "Готово.";
      i += 1;
      return {
        text,
        toolUses: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        stubbed: false,
      };
    },
    completeStream: (req: LlmRequest, onDelta: (d: { text?: string }) => void) =>
      streamViaComplete(self, req, onDelta),
  };
  return self as unknown as ILlmProvider & { requests: LlmRequest[] };
}

describe("Б6: бюджет разговорного хода", () => {
  it("вопрос регистрируется conversational-задачей — не всплывает в active/«сделал?»", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider(); // дефолт «Готово.» одним ходом, без tool-use
    const tasks = new TaskManager();
    const deps = await makeDeps(llm, { tasks });
    await handleUserText(session, "что такое рекурсия?", deps);
    // Задача хода помечена conversational и не считается активной содержательной работой.
    const all = tasks.list("u1");
    expect(all.length).toBe(1);
    expect(all[0]?.conversational).toBe(true);
    expect(tasks.activeForUser("u1")).toHaveLength(0); // не всплывает как фоновая
    expect(tasks.recentTerminal("u1")).toHaveLength(0); // и не попадёт в «что делал?»
  });

  it("кап tool-раундов на разговорном ходе (не уходит в 50-раундовую петлю)", async () => {
    const session = fakeSession();
    // Модель на разговорном ходе «упорно» зовёт screen_capture — кап 12 обрывает runaway (не 50).
    const llm = new MockLlmProvider(
      Array.from({ length: 30 }, () => ({ toolUses: [{ id: "t", name: "screen_capture", input: {} }] })),
    );
    const deps = await makeDeps(llm, {});
    await handleUserText(session, "как думаешь, я молодец?", deps);
    expect(llm.requests.length).toBeLessThanOrEqual(13); // кап 12 tool-раундов + возможный финал, не 30/50
  });

  it("(ревью #4) кап исчерпан без текстового ответа → честный терминал, НЕ ложное «Готово»", async () => {
    const session = fakeSession();
    const tasks = new TaskManager();
    // Разговорный ход: модель зовёт инструмент КАЖДЫЙ раунд, никогда не отвечает словами → кап 12 исчерпан.
    const llm = new MockLlmProvider(
      Array.from({ length: 14 }, () => ({ toolUses: [{ id: "t", name: "screen_capture", input: {} }] })),
    );
    const sendAction = vi.fn(() => Promise.resolve({ commandId: "c", ok: true, durationMs: 1, data: { image: "QUFB", mediaType: "image/png" } }));
    const sess = { sessionId: "s1", userId: "u1", sendAction, send: vi.fn() } as unknown as Session;
    void session;
    const reply = await handleUserText(sess, "что там по погоде и по биткоину?", await makeDeps(llm, { tasks }));
    // Не ложное «Готово» на вопрос без ответа — честный терминал.
    expect(reply.voice).not.toContain("Готово");
    expect(reply.voice.toLowerCase()).toMatch(/переспрос|не успел|остановил/);
    // И задача записана как НЕуспех (fail), а не done.
    expect(tasks.list("u1")[0]?.state).toBe("failed");
  });

  it("(ревью 3-й/4-й проход #5/#1) модель УСПЕЛА ответить, нудж обнулил finalText, кап исчерпан → ОТДАЁМ ответ", async () => {
    const session = fakeSession();
    const tasks = new TaskManager();
    // conversational (кап 12): 11 нейтральных чтений → на 12-м (текстовом) ходе goal-check обнулит
    // finalText для переспроса, но кап 12 переспросить не даст. Сохранённый ответ обязан прозвучать
    // (и ТОЛЬКО на conversational — #1: на action-задаче отвергнутый текст не воскрешаем).
    const llm = new MockLlmProvider([
      ...Array.from({ length: 11 }, (_, i) => ({ toolUses: [{ id: `a${i}`, name: "memory_search", input: { query: `рекурсия ${i}` } }] })),
      { text: "Рекурсия — это когда функция вызывает саму себя, сэр." },
    ]);
    const reply = await handleUserText(session, "что такое рекурсия?", await makeDeps(llm, { tasks }));
    expect(reply.voice).toContain("Рекурсия"); // реальный ответ отдан, НЕ ложное «не успел»
    expect(reply.voice).not.toMatch(/не успел|переспрос/);
  });
});

describe("Б4 (г/д): channel_down в петле — ждём reconnect, не эскалируем", () => {
  it("канал упал на действии → петля ждёт и НЕ считает это провалом модели (нет эскалации)", async () => {
    // Первый вызов input.click возвращает channel_down; после «reconnect» действие проходит.
    let down = true;
    const sendAction = vi.fn((cmd: ActionCommand) => {
      if (cmd.kind === "input.click" && down)
        return Promise.resolve({ commandId: "c", ok: false, error: { code: "channel_down" as const, message: "канал недоступен" }, durationMs: 0 });
      return Promise.resolve({ commandId: "c", ok: true, durationMs: 1, data: { image: "QUFB", mediaType: "image/png" } });
    });
    const session = { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), channelUp: () => !down } as unknown as Session;
    const click = { toolUses: [{ id: "t1", name: "input_click", input: { target: { by: "coords", x: 10, y: 20, space: "screen" } } }] };
    const llm = new MockLlmProvider([
      click, // раунд 1: канал мёртв → channel_down → петля ждёт reconnect и повторяет
      click, // раунд 2: канал восстановлен → клик прошёл (mutate success)
      { toolUses: [{ id: "t2", name: "screen_capture", input: {} }] }, // сверка глазами после клика
      { text: "Готово, сэр." },
    ]);
    const deps = await makeDeps(llm, {});
    // Через 50мс канал восстанавливается (клиент reconnect) — waitForChannel это увидит.
    setTimeout(() => { down = false; }, 50);
    const reply = await handleUserText(session, "ткни по кнопке на экране и сверь", deps);
    // Задача НЕ прервана терминально как «связь прервалась»: дождались reconnect и довели.
    expect(reply.voice).toContain("Готово");
    // channel_down НЕ вызвал эскалацию тира (запросы к LLM шли той же слабой моделью).
    expect(llm.requests.every((r) => r.model === deps.models.sonnet)).toBe(true);
  });
});

describe("Б3 live-рефреш контекста в длинной задаче", () => {
  it("изменившийся снимок ПК впрыскивается хвостом после нескольких раундов", async () => {
    const session = fakeSession();
    // 6 tool-use раундов (memory_search — читающий; РАЗНЫЕ query, чтобы не триггерить anti-runaway) + финал.
    const llm = new MockLlmProvider(
      Array.from({ length: 7 }, (_, i) =>
        i < 6 ? { toolUses: [{ id: `t${i}`, name: "memory_search", input: { query: `запрос ${i}` } }] } : { text: "Готово, сэр." },
      ),
    );
    const deps = await makeDeps(llm, { userContext: { systemContext: "Окно: Блокнот" } });
    // Клиент прислал свежий client.system во время задачи (роутер мутирует deps.userContext.systemContext):
    // имитируем это, меняя снимок после 3-го LLM-вызова.
    const orig = llm.complete.bind(llm);
    let calls = 0;
    llm.complete = async (req) => {
      calls += 1;
      if (calls === 4) deps.userContext = { ...deps.userContext, systemContext: "Окно: Dota 2 (полноэкранно)" };
      return orig(req);
    };
    await handleUserText(session, "сделай долгую многошаговую работу с окнами", deps);
    // Свежий снимок доехал до модели ХВОСТОМ (не пересборкой system-блока).
    const allMsgs = JSON.stringify(llm.requests.map((r) => r.messages));
    expect(allMsgs).toContain("ОБСТАНОВКА НА ПК ОБНОВИЛАСЬ");
    expect(allMsgs).toContain("Dota 2");
    // Впрыск — в некешируемый хвост messages, НЕ в системный блок (кеш §15 цел).
    expect(JSON.stringify(llm.requests.map((r) => r.systemDynamic ?? ""))).not.toContain("Dota 2");
  });

  it("снимок НЕ менялся → лишних впрысков нет (не спамим тем же)", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider(
      Array.from({ length: 7 }, (_, i) =>
        i < 6 ? { toolUses: [{ id: `t${i}`, name: "memory_search", input: { query: `запрос ${i}` } }] } : { text: "Готово." },
      ),
    );
    const deps = await makeDeps(llm, { userContext: { systemContext: "Окно: Блокнот" } });
    await handleUserText(session, "долгая многошаговая работа", deps);
    expect(JSON.stringify(llm.requests.map((r) => r.messages))).not.toContain("ОБСТАНОВКА НА ПК ОБНОВИЛАСЬ");
  });

  it("(ревью #2/#3) впрыски снимка ограничены капом за задачу — не копятся десятки (кеш не ломаем прунингом)", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider(
      Array.from({ length: 40 }, (_, i) =>
        i < 39 ? { toolUses: [{ id: `t${i}`, name: "memory_search", input: { query: `q${i}` } }] } : { text: "Готово." },
      ),
    );
    const deps = await makeDeps(llm, { userContext: { systemContext: "Окно 0" } });
    let n = 0;
    const orig = llm.complete.bind(llm);
    llm.complete = async (req) => {
      n += 1;
      deps.userContext = { ...deps.userContext, systemContext: `Окно ${n}` }; // снимок меняется каждый раунд
      return orig(req);
    };
    await handleUserText(session, "очень долгая работа с окнами", deps);
    // В ПОСЛЕДНЕМ запросе число впрысков снимка ограничено капом (MAX_LIVE_REFRESHES=4), не растёт с раундами.
    const lastMsgs = JSON.stringify(llm.requests[llm.requests.length - 1]?.messages ?? []);
    const liveCount = (lastMsgs.match(/ОБСТАНОВКА НА ПК ОБНОВИЛАСЬ/g) ?? []).length;
    expect(liveCount).toBeGreaterThan(0); // впрыски были
    expect(liveCount).toBeLessThanOrEqual(4); // но ограничены капом, не десятки
  });
});

describe("replayUnsafe — гарды слепого реплея (ревью фиксов Волны 3, #2/#8/#11)", () => {
  const type = (needsLlm = false): SkillStep => ({ action: "input.type", needsLlm, params: {} });

  it("(#8) compose→click: input.click ПОСЛЕ input.type блокирует реплей", () => {
    expect(replayUnsafe([type(), { action: "input.click", params: {} }])).toBe(true);
  });

  it("(#11) compose→invoke: ui.invoke/input.mouse ПОСЛЕ input.type блокируют реплей", () => {
    expect(replayUnsafe([type(), { action: "ui.invoke", params: { name: "Отправить" } }])).toBe(true);
    expect(replayUnsafe([type(), { action: "input.mouse", params: { op: "down" } }])).toBe(true);
  });

  it("клик ДО сочинения текста — безопасен (клик по полю ввода, потом печать)", () => {
    expect(replayUnsafe([{ action: "input.click", params: {} }, type()])).toBe(false);
  });

  it("Enter после type — блок; не-коммитная клавиша (Ctrl+A) — нет", () => {
    expect(replayUnsafe([type(), { action: "input.key", params: { combo: "ctrl+enter" } }])).toBe(true);
    expect(replayUnsafe([type(), { action: "input.key", params: { combo: "ctrl+a" } }])).toBe(false);
  });

  it("(#5) опасная URI-схема в browser.open/app.launch — блок; https — нет", () => {
    expect(replayUnsafe([{ action: "browser.open", params: { url: "file:///c:/x" } }])).toBe(true);
    expect(replayUnsafe([{ action: "app.launch", params: { app: "ms-msdt:/id x" } }])).toBe(true);
    expect(replayUnsafe([{ action: "browser.open", params: { url: "https://ya.ru" } }])).toBe(false);
  });

  // Ревью 2-го прохода (R1): ввод текста — не только input.type; ui.invoke pattern="setValue" пишет
  // текст в контрол через UIA (demo-запись его легитимно генерит) → после него коммит = та же дыра.
  it("(R1) ui.invoke setValue → Enter/клик — блок (обход compose-гарда через UIA-ввод)", () => {
    const setValue: SkillStep = { action: "ui.invoke", params: { pattern: "setValue", value: "текст" } };
    expect(replayUnsafe([setValue, { action: "input.key", params: { combo: "enter" } }])).toBe(true);
    expect(replayUnsafe([setValue, { action: "input.click", params: {} }])).toBe(true);
    // setValue без последующего коммита — безопасен (просто заполнение поля).
    expect(replayUnsafe([{ action: "app.focus", params: {} }, setValue])).toBe(false);
  });

  // Ревью 2-го прохода (R2): длинный input.type неотменяем (5с+120мс/символ, до 180с) — не реплеим.
  it("(R2) input.type/setValue с текстом длиннее капа — блок реплея", () => {
    const long = "х".repeat(200);
    expect(replayUnsafe([{ action: "input.type", params: { text: long } }])).toBe(true);
    expect(replayUnsafe([{ action: "ui.invoke", params: { pattern: "setValue", value: long } }])).toBe(true);
    expect(replayUnsafe([{ action: "input.type", params: { text: "коротко" } }])).toBe(false);
  });

  it("(#2) префилл сделал шаги опасными (combo:enter) → реплей ОТМЕНЁН, skill.execute не уходит", async () => {
    const sendAction = vi.fn(() => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 }));
    const session = fakeSession(sendAction);
    // 1-й вызов = префилл (заполняет text и ОПАСНЫЙ combo), 2-й = обычная петля.
    const llm = scriptedLlm(['{"1": {"text": "gg wp"}, "2": {"combo": "enter"}}', "Сделал по процедуре, сэр."]);
    const recall = vi.fn(async () => ({
      id: "learned__compose-send",
      ownerId: "u-1",
      name: "Написать в чат",
      when: "написать сообщение в чате",
      procedure: "проза",
      version: 1,
      steps: [
        { action: "app.focus", params: { app: "telegram" } },
        { action: "input.type", needsLlm: true, params: {} },
        { action: "input.key", needsLlm: true, params: {} }, // combo пуст → пре-чек молчит
      ] as SkillStep[],
      needsReview: false,
    }));
    const mock = new MockLlmProvider();
    const deps = await makeDeps(mock, { skills: fakeSkills({ recall }) });
    deps.llm = llm;
    const reply = await handleUserText(session, "запусти поиск в доте", deps);
    // Реплей НЕ ушёл: после префилла гард перепроверил заполненные шаги и отменил слепой макрос.
    const kinds = (sendAction.mock.calls as unknown as Array<[{ kind?: string }]>).map((c) => c[0]?.kind);
    expect(kinds).not.toContain("skill.execute");
    // Петля получила честную пометку об отмене макроса (идёт по процедуре, где действуют send-гарды).
    const loopMsgs = JSON.stringify(llm.requests[1]?.messages ?? []);
    expect(loopMsgs).toContain("не выполнился");
    expect(reply.voice).toContain("Сделал по процедуре");
  });
});
