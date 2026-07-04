import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
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
import { type AgentDeps, handleUserText, waitWhilePaused } from "./index.js";
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
      recall: async () => ({ id: "tg", name: "Отправить Герману", when: "написать Herman", procedure: "шаги...", version: 1 }),
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

  it("§8 HERMES: recall подбирает навык и вшивает его процедуру в системный промпт", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider([{ text: "Готово." }]);
    const recall = vi.fn(async () => ({
      id: "tg-report",
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
    const recall = vi.fn(async () => ({ id: "k", name: "К", when: "сложная задача", procedure: "шаги", version: 1 }));
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
