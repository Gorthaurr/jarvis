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

  it("детерминированный путь (имя) ничего не стримит, но финализирует через done()", async () => {
    const llm = new MockLlmProvider([]);
    const { sink, sentences, getDone } = collectSink();
    const reply = await handleUserText(session, "зови меня Антон", makeDeps(llm), sink);
    expect(sentences).toEqual([]); // не было пофразной генерации
    expect(getDone()).toBe(reply.voice); // done несёт полный голос — пайплайн произнесёт его целиком
    expect(reply.voice).toContain("Антон");
  });
});
