/**
 * §10 realtime: brain отдаёт реплику ПОФРАЗНО через ReplySink (token-streaming).
 * Проверяем: конверсационный ответ режется на предложения и КАЖДОЕ вербализуется под TTS
 * (§21), а детерминированные пути (имя) ничего не стримят, но финализируют через done().
 */
import { describe, expect, it, vi } from "vitest";
import { SpendGuard } from "../../billing/index.js";
import { type ILlmProvider, MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import type { Session } from "../../gateway/session.js";
import { type AgentDeps, type ReplySink, handleUserText } from "./index.js";

function collectSink() {
  const sentences: string[] = [];
  let doneFull: string | null = null;
  const sink: ReplySink = {
    sentence: (s) => sentences.push(s),
    display: () => {},
    done: (full) => {
      doneFull = full;
    },
  };
  return { sink, sentences, getDone: () => doneFull };
}

function makeDeps(llm: ILlmProvider): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    bgTasks: new Set(),
  };
}

const session = { sessionId: "s1", userId: "u1", send: vi.fn() } as unknown as Session;

describe("brain пофразный стрим (§10)", () => {
  it("конверсационный ответ отдаётся по предложениям; done == полный голос", async () => {
    const llm = new MockLlmProvider([{ text: "Привет, сэр. Чем могу помочь?" }]);
    const { sink, sentences, getDone } = collectSink();
    const reply = await handleUserText(session, "поболтай со мной немного", makeDeps(llm), sink);
    expect(sentences).toEqual(["Привет, сэр.", "Чем могу помочь?"]);
    expect(getDone()).toBe(reply.voice);
  });

  it("каждое стримленное предложение вербализуется под TTS (§21): числа → слова", async () => {
    const llm = new MockLlmProvider([{ text: "Нашёл 3 машины. Дешевле всех за 500 рублей." }]);
    const { sink, sentences } = collectSink();
    await handleUserText(session, "посмотри что там по машинам", makeDeps(llm), sink);
    // «3» → «три», «500 рублей» → разговорное число + согласование — НЕ сырые цифры в TTS.
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toBe("Нашёл три машины.");
    expect(sentences.join(" ")).not.toMatch(/\d/);
  });

  it("ТЕКСТОВАЯ преамбула перед tool_use НЕ озвучивается — звучит только финал (анти-двойной-голос)", async () => {
    // Claude штатно говорит «Сейчас проверю…» перед инструментом. Раньше эта преамбула
    // стримилась в голос, а потом ещё и финал → двойной голос. Теперь преамбула (1 фраза)
    // держится и отбрасывается на tool-ходе; звучит только итог после инструмента.
    const llm = new MockLlmProvider([
      { text: "Сейчас проверю погоду.", toolUses: [{ id: "t1", name: "web_search", input: { query: "погода" } }] },
      { text: "В Москве плюс пять." },
    ]);
    const { sink, sentences } = collectSink();
    await handleUserText(session, "узнай погоду в москве", makeDeps(llm), sink);
    expect(sentences).not.toContain("Сейчас проверю погоду."); // преамбула не озвучена
    expect(sentences.join(" ")).toContain("плюс пять"); // финал озвучен
  });

  it("трёхпредложенный ответ стримится весь (eager после 2-й фразы)", async () => {
    const llm = new MockLlmProvider([{ text: "Раз. Два. Три." }]);
    const { sink, sentences } = collectSink();
    await handleUserText(session, "поговори со мной подольше", makeDeps(llm), sink);
    expect(sentences).toEqual(["Раз.", "Два.", "Три."]);
  });

  it("M5: аварийный стаб, уже озвученный в sink, НЕ перезаписывается другой фразой (память=произнесённое)", async () => {
    // Стаб LLM (stopReason==="stub") на step0-стриме проговаривается пофразно (spokeAny/streamedFinal).
    // Терминал llmStubbed раньше возвращал ДРУГОЙ текст («связь прервалась») → память/чат расходились
    // с тем, что реально прозвучало. Теперь done()/voice == реально произнесённый стаб-текст.
    const llm = new MockLlmProvider([
      { text: "Первое предложение стаба. Второе предложение стаба.", stopReason: "stub" },
    ]);
    const { sink, sentences, getDone } = collectSink();
    const reply = await handleUserText(session, "поболтай со мной немного", makeDeps(llm), sink);
    // Прозвучал именно стаб-текст (пофразно), а не «связь с сервером прервалась».
    expect(sentences).toEqual(["Первое предложение стаба.", "Второе предложение стаба."]);
    expect(reply.voice).not.toMatch(/связь/i); // терминал НЕ подставил чужую фразу
    // done()/voice == реально произнесённое (сшитое из тех же предложений).
    expect(getDone()).toBe(reply.voice);
    expect(reply.voice).toBe(sentences.join(" "));
  });

  it("детерминированный путь (имя) ничего не стримит, но финализирует через done()", async () => {
    const llm = new MockLlmProvider([]);
    const { sink, sentences, getDone } = collectSink();
    const reply = await handleUserText(session, "зови меня Антон", makeDeps(llm), sink);
    expect(sentences).toEqual([]); // не было пофразной генерации
    expect(getDone()).toBe(reply.voice); // done несёт полный голос — пайплайн произнесёт его целиком
    expect(reply.voice).toContain("Антон");
  });
});

/**
 * W2 «Мозг быстрый» (2026-09-09). Провайдер-обёртка: помнит, сколько фраз уже ушло в голос на момент
 * КАЖДОГО обращения к модели, и фиксирует release(sessionKey) — проводка петли с сессией провайдера.
 */
function observingLlm(script: ConstructorParameters<typeof MockLlmProvider>[0], sentences: string[]) {
  const inner = new MockLlmProvider(script);
  const spokenAtCall: number[] = [];
  const released: string[] = [];
  const llm: ILlmProvider = {
    live: false,
    complete: async (req) => {
      spokenAtCall.push(sentences.length);
      return inner.complete(req);
    },
    completeStream: async (req, onDelta) => {
      spokenAtCall.push(sentences.length);
      return inner.completeStream(req, onDelta);
    },
    release: (key) => {
      released.push(key);
    },
  };
  return { llm, inner, spokenAtCall, released };
}

describe("W2: первая фраза разговора — сразу; сессия модели — на задачу", () => {
  it("на РАЗГОВОРНОМ ходе преамбула перед инструментом звучит ДО его исполнения, финал — после (не дублируется)", async () => {
    const { sink, sentences } = collectSink();
    const { llm, spokenAtCall } = observingLlm(
      [
        { text: "Сейчас проверю погоду.", toolUses: [{ id: "t1", name: "web_search", input: { query: "погода" } }] },
        { text: "В Москве плюс пять." },
      ],
      sentences,
    );
    await handleUserText(session, "какая сейчас погода в москве?", makeDeps(llm), sink);
    expect(sentences[0]).toBe("Сейчас проверю погоду."); // первая фраза ушла сразу, без ожидания второй
    expect(spokenAtCall[1]).toBe(1); // ко второму обращению к модели она УЖЕ прозвучала
    expect(sentences.filter((s) => s.includes("плюс пять"))).toHaveLength(1); // финал ровно один раз
    expect(sentences.filter((s) => s.includes("проверю"))).toHaveLength(1); // преамбула ровно один раз
  });

  it("на action-пути (команда) преамбула по-прежнему НЕ стримится (гард ≥2 фраз, анти-двойной-голос)", async () => {
    const { sink, sentences } = collectSink();
    const { llm } = observingLlm(
      [
        { text: "Сейчас открою.", toolUses: [{ id: "t1", name: "app_launch", input: { app: "блокнот" } }] },
        { text: "Открыл блокнот." },
      ],
      sentences,
    );
    await handleUserText(session, "открой мне пожалуйста блокнот и подготовь его", makeDeps(llm), sink);
    expect(sentences).not.toContain("Сейчас открою.");
  });

  it("петля даёт каждому обращению sessionKey = id задачи и освобождает сессию в finally ровно один раз", async () => {
    const { sink, sentences } = collectSink();
    const { llm, inner, released } = observingLlm(
      [
        { text: "", toolUses: [{ id: "t1", name: "web_search", input: { query: "погода" } }] },
        { text: "В Москве плюс пять." },
      ],
      sentences,
    );
    await handleUserText(session, "какая сейчас погода в москве?", makeDeps(llm), sink);
    const keys = new Set(inner.requests.map((r) => r.sessionKey));
    expect(keys.size).toBe(1); // одна сессия на задачу, оба раунда с одним ключом
    const key = [...keys][0];
    expect(typeof key).toBe("string");
    expect(released).toEqual([key]);
  });
});
