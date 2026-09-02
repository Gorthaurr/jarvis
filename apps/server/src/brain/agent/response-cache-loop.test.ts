/**
 * 🔴 Семантический кэш ответов (§15) — ПРОВОДКА в живой петле `handleUserText`, не чистая функция.
 *
 * ЖИВОЙ ДЕФЕКТ (волна D, 2026-07-29): «отмени напоминание про таблетки» получило ответ ИЗ КЭША
 * (sim 1.0) — петля не запускалась ВООБЩЕ, напоминание осталось стоять, а владельцу зачитали
 * устаревшее утверждение о составе списка. Денилист `isCacheableQuery` дыру не закрыл и закрыть не
 * может (стем «напомн» не ловит «напомин-а-ние», «отмен» в списке команд не было) — денилист
 * принципиально неполон. Поэтому решает ПОЛОЖИТЕЛЬНЫЙ признак роутера: кэш работает ТОЛЬКО на
 * разговорном ходе (вопрос), и записывается тоже только он и только при НУЛЕВОЙ траектории
 * инструментов.
 *
 * ПОЧЕМУ ЮНИТ-ТЕСТЫ ЭТОГО НЕ ЛОВИЛИ: покрыты `isCacheableQuery` (чистая) и сам
 * `SemanticResponseCache` (изолированно) — оба продолжают работать как раньше. А ТРИ гейта живут в
 * петле: `decision.conversational === true` у lookup (index.ts ~925) и
 * `toolTrajectory.length === 0 && opts?.conversational === true` у store (~3422). Снять любой из них —
 * весь пакет остаётся зелёным, потому что ни один тест не гонял кэш ЧЕРЕЗ `handleUserText`
 * (единственный существовавший — фейковый store на стаб-ходе, он выходит из петли раньше гейта).
 *
 * Тесты работают с РЕАЛЬНЫМ `SemanticResponseCache` (детерминированный HashEmbeddingProvider:
 * одинаковый текст → одинаковый вектор → sim 1.0, как в живом инциденте) и РЕАЛЬНЫМ роутером —
 * подменён только LLM (скрипт ответов) и канал к ПК.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { SemanticResponseCache } from "../response-cache.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

/** КОМАНДА (роутер: не conversational, тир sonnet), при этом ПРОХОДЯЩАЯ денилист `isCacheableQuery` —
 *  ровно класс живого инцидента: денилист неполон, гейт обязан держать роутером. */
const COMMAND = "приготовь список покупок в блокноте";
/** ВОПРОС (роутер: conversational) — законный клиент кэша. */
const QUESTION = "какая столица Австралии";

/** Сессия с записывающим каналом к ПК: по нему видно, ИСПОЛНИЛАСЬ ли команда на самом деле. */
function fakeSession() {
  const sendAction = vi.fn((_cmd: ActionCommand, _t?: number) =>
    Promise.resolve({ commandId: "c", ok: true, durationMs: 1 }),
  );
  return { sessionId: "s1", userId: "u1", sendAction, send: vi.fn() } as unknown as Session & {
    sendAction: typeof sendAction;
  };
}

function makeDeps(llm: MockLlmProvider, cache: SemanticResponseCache, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks: new TaskManager(),
    responseCache: cache,
    ...over,
  };
}

const newCache = () => new SemanticResponseCache(new HashEmbeddingProvider());
/** store в петле — fire-and-forget (`void`): даём эмбеддингу и записи завершиться. */
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("§15 кэш ответов: КОМАНДА не обслуживается кэшем (живой инцидент «отмени напоминание»)", () => {
  it("попадание в кэш НЕ отменяет исполнение команды: петля идёт в LLM и действие уходит на ПК", async () => {
    const cache = newCache();
    const cached = "Список покупок уже составлен, сэр.";
    await cache.store("u1", COMMAND, cached);
    // Предусловие честности теста: кэш РЕАЛЬНО отдал бы этот ответ, если бы петля его спросила.
    // Без этой проверки тест мог бы «проходить» просто потому, что попадания и не было.
    expect(await cache.lookup("u1", COMMAND)).toBe(cached);

    const session = fakeSession();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "w1", name: "fs_write", input: { path: "C:/tmp/список.txt", content: "молоко" } }] },
      { text: "Список записал в блокнот, сэр." },
    ]);
    const reply = await handleUserText(session, COMMAND, makeDeps(llm, cache));

    expect(llm.requests.length).toBeGreaterThan(0); // до фикса: 0 — модель не вызывалась вообще
    const kinds = session.sendAction.mock.calls.map((c) => c[0]?.kind);
    expect(kinds).toContain("fs.write"); // команда реально ИСПОЛНЕНА, а не «отвечена» из кэша
    expect(reply.voice).not.toBe(cached);
  });

  it("ответ на КОМАНДУ в кэш не кладётся (иначе он обслужит любую будущую такую команду)", async () => {
    const cache = newCache();
    expect(await cache.lookup("u1", COMMAND)).toBeNull(); // старт с пустого кэша

    const session = fakeSession();
    // Ход БЕЗ инструментов: модель лишь переспрашивает. Именно такой переспрос (с числами/состоянием)
    // и оседал бы «готовым ответом» на команду.
    const llm = new MockLlmProvider([
      { text: "В какой файл записать список, сэр?" },
      { text: "В какой файл записать список, сэр?" },
      { text: "В какой файл записать список, сэр?" },
    ]);
    await handleUserText(session, COMMAND, makeDeps(llm, cache));
    await settle();

    // До фикса гейта у store: команда оседала в кэше и следующая такая же уходила бы в обход петли.
    expect(await cache.lookup("u1", COMMAND)).toBeNull();
  });
});

describe("§15 кэш ответов: на ВОПРОСЕ механизм реально работает (не «выключен насовсем»)", () => {
  it("разговорный ход БЕЗ инструментов наполняет кэш", async () => {
    const cache = newCache();
    const session = fakeSession();
    const llm = new MockLlmProvider([{ text: "Столица Австралии — Канберра." }]);
    await handleUserText(session, QUESTION, makeDeps(llm, cache));
    await settle();

    const stored = await cache.lookup("u1", QUESTION);
    expect(stored).not.toBeNull();
    expect(stored).toContain("Канберра");
  });

  it("на повторный вопрос кэш отвечает СРАЗУ — LLM не вызывается", async () => {
    const cache = newCache();
    const answer = "Столица Австралии — Канберра.";
    await cache.store("u1", QUESTION, answer);

    const session = fakeSession();
    const llm = new MockLlmProvider([{ text: "не должно вызваться" }]);
    const reply = await handleUserText(session, QUESTION, makeDeps(llm, cache));

    expect(llm.requests).toHaveLength(0);
    expect(reply.voice).toContain("Канберра");
  });

  it("разговорный ход С ИНСТРУМЕНТОМ в кэш НЕ кладётся (реплей не должен выдавать старый результат за свежий)", async () => {
    const cache = newCache();
    const session = fakeSession();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "s1", name: "web_search", input: { query: "столица Австралии" } }] },
      { text: "Столица Австралии — Канберра." },
    ]);
    await handleUserText(session, QUESTION, makeDeps(llm, cache));
    await settle();

    // До фикса гейта `toolTrajectory.length === 0`: ответ с траекторией инструментов кэшировался,
    // и повтор вопроса отдавал бы его БЕЗ единого вызова инструмента.
    expect(await cache.lookup("u1", QUESTION)).toBeNull();
  });
});
