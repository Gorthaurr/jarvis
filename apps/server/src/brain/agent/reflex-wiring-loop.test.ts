/**
 * 🔴 ПРОВОДКА ДВУХ РЕФЛЕКСОВ в РЕАЛЬНОЙ петле `handleUserText` (волна А3 «память» + волна D2
 * «обязательства»).
 *
 * Какой живой дефект охраняем. В `agent/index.ts` стоят два fire-and-forget вызова:
 *   1) `hasStableFactMarker(clean)` → `reflectFactFromUtterance(...)` — «я работаю по ночам» само
 *      становится фактом в памяти (диагноз ревью: facts:0 за 15 дней — сама модель memory_write не
 *      звала, у процедур авто-петля была, у фактов о владельце — ничего);
 *   2) `!machineTurn && deps.reminders && hasCommitmentMarker(clean)` →
 *      `reflectCommitmentFromUtterance({..., onCreated})` — «завтра надо позвонить маме» само
 *      становится напоминанием, и Джарвис ОБЯЗАН сказать вслух, что взял дело на себя.
 *
 * Почему юнит-тесты этого НЕ ловят. Соседние `memory-reflect.test.ts` и `commitment-reflect.test.ts`
 * проверяют ЧИСТЫЕ префильтры (`hasStableFactMarker`/`hasCommitmentMarker`) и сами функции
 * рефлексии, вызванные НАПРЯМУЮ. Между префильтром и функцией лежит проводка, которую не проверял
 * никто: удалить оба `void reflect...()` из петли — весь прогон остаётся зелёным, а фича мертва
 * (владелец говорит вслух о своём деле, и не происходит НИЧЕГО). Сюда же две латентные мутации:
 *   • снять гард `!machineTurn` — машинный реэнтри наблюдений (`origin:"watch-action"`) начнёт
 *     ставить напоминания из «речи владельца», которой не было: текст поручения сгенерирован
 *     сервисом watch, а не сказан человеком;
 *   • подменить `onCreated` пустышкой — напоминание ставится МОЛЧА. Прямое нарушение закона волны D
 *     («молчаливых будильников не ставим»): владелец узнает о деле, только когда оно заговорит само.
 * Порода та же, что у `gateStoppedRound` в контроле-3 Ф0: проводку между механизмами проверяем
 * ПЕТЛЁЙ, а не чистыми функциями.
 *
 * Тесты честные: смотрят на НАБЛЮДАЕМЫЙ исход (запись в эпизодической памяти, запись в сторе
 * напоминаний, произнесённая владельцу фраза), а не на наличие строк в исходнике.
 *
 * ⚠️ В `apps/server/vitest.setup.ts` рефлекс памяти намеренно заглушён (`JARVIS_MEMORY_REFLECT=0`),
 * чтобы фоновый LLM-вызов не съедал скриптованные ответы моков в остальных файлах. Здесь он
 * включается ЛОКАЛЬНО через `vi.stubEnv` и снимается в afterEach (`vi.unstubAllEnvs`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import type { ILlmProvider, LlmDelta, LlmRequest, LlmResponse, ToolUse } from "../../integrations/llm.js";
import { streamViaComplete } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { ReminderService } from "../../proactive/reminders/service.js";
import { ReminderStore } from "../../proactive/reminders/store.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, type AgentReply, handleUserText } from "./index.js";

/** Какой из двух рефлексов сделал этот запрос: у обоих — УЗКИЙ набор из одного инструмента. */
type ReflexKind = "memory" | "commitment";

function reflexOf(req: LlmRequest): ReflexKind | null {
  const names = (req.tools ?? []).map((t) => t.name);
  if (names.length !== 1) return null; // основная петля шлёт весь горячий арсенал
  if (names[0] === "memory_write") return "memory";
  if (names[0] === "set_reminder") return "commitment";
  return null;
}

/**
 * LLM, который РАЗЛИЧАЕТ ходы: рефлексы и основная петля идут в ОДИН И ТОТ ЖЕ `deps.llm`, поэтому
 * скриптованный по порядку MockLlmProvider тут не годится (фоновый вызов съел бы ответ петли и
 * наоборот). Маршрутизируем по набору инструментов запроса.
 */
class RoutingLlm implements ILlmProvider {
  readonly live = false;
  readonly requests: LlmRequest[] = [];

  constructor(private readonly reflexAnswer: Partial<Record<ReflexKind, ToolUse>> = {}) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const kind = reflexOf(req);
    const tu = kind ? this.reflexAnswer[kind] : undefined;
    return {
      text: kind ? "" : "Хорошо, сэр.",
      toolUses: tu ? [tu] : [],
      stopReason: tu ? "tool_use" : "end_turn",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stubbed: true,
    };
  }

  completeStream(req: LlmRequest, onDelta: (d: LlmDelta) => void): Promise<LlmResponse> {
    return streamViaComplete(this, req, onDelta);
  }

  /** Сколько раз дёрнули конкретный рефлекс — наблюдаемый признак «проводка жива». */
  countOf(kind: ReflexKind): number {
    return this.requests.filter((r) => reflexOf(r) === kind).length;
  }
}

/** Сессия-заглушка: рефлексам от неё нужен sessionId, петле — sendAction/send. */
function fakeSession(userId: string): Session {
  return {
    sessionId: `sess-${userId}`,
    userId,
    send: vi.fn(),
    sendAction: vi.fn((_c: ActionCommand) => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 })),
    requestConfirm: vi.fn(() => Promise.resolve({ requestId: "r", approved: true, outcome: "approved" as const })),
  } as unknown as Session;
}

function makeDeps(llm: ILlmProvider, userId: string, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId,
    tasks: new TaskManager(),
    ...over,
  };
}

/** Рефлексы — fire-and-forget: ход возвращается РАНЬШЕ них, поэтому ждём наблюдаемый исход. */
async function waitUntil(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Дать фоновому рефлексу ЗАВЕДОМО достаточно времени — для отрицательных утверждений. */
const settle = (ms = 250): Promise<void> => new Promise((r) => setTimeout(r, ms));

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-reflex-wiring-"));
  // Сетап глушит рефлекс памяти глобально — включаем локально (как memory-reflect.test.ts).
  vi.stubEnv("JARVIS_MEMORY_REFLECT", "1");
  vi.stubEnv("JARVIS_MEMORY_REFLECT_CAP", "100");
  vi.stubEnv("JARVIS_COMMITMENT_REFLECT", "1");
  vi.stubEnv("JARVIS_COMMITMENT_REFLECT_CAP", "100");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await settle(50); // цепочка записи ReminderStore асинхронна — не сносим каталог у неё из-под ног
  rmSync(dir, { recursive: true, force: true });
});

describe("рефлекс ПАМЯТИ подключён к петле (А3)", () => {
  it("реплика с маркером устойчивого факта → рефлексия и факт в эпизодической памяти", async () => {
    const llm = new RoutingLlm({
      memory: { id: "m1", name: "memory_write", input: { kind: "fact", content: "Работает по ночам" } },
    });
    const deps = makeDeps(llm, "u-mem-1");
    const episodic = deps.episodic as InMemoryEpisodicMemory;

    await handleUserText(fakeSession("u-mem-1"), "кстати, я работаю по ночам", deps);

    // ← без `void reflectFactFromUtterance(...)` в петле рефлексия не случится вовсе
    expect(await waitUntil(() => llm.countOf("memory") > 0)).toBe(true);
    // Наблюдаемый исход, а не только факт вызова: запись реально легла в память пользователя.
    const landed = await waitUntil(async () => {
      const items = (await episodic.listRecent?.("u-mem-1", 20)) ?? [];
      return items.some((e) => e.text === "Работает по ночам");
    });
    expect(landed).toBe(true);
    // Узкий набор инструментов — признак именно рефлексии (петля шлёт полный арсенал).
    expect(llm.requests.find((r) => reflexOf(r) === "memory")?.tools?.map((t) => t.name)).toEqual(["memory_write"]);
  });

  it("обычная команда без маркера факта рефлексию НЕ будит (деньги на каждом ходе не жжём)", async () => {
    const llm = new RoutingLlm({
      memory: { id: "m1", name: "memory_write", input: { kind: "fact", content: "не должно записаться" } },
    });
    const deps = makeDeps(llm, "u-mem-2");
    await handleUserText(fakeSession("u-mem-2"), "сделай сводку новостей", deps);
    await settle();
    expect(llm.countOf("memory")).toBe(0);
  });
});

describe("рефлекс ОБЯЗАТЕЛЬСТВ подключён к петле и ГОВОРИТ вслух (D2)", () => {
  function commitmentSetup(userId: string, spoken: string[]) {
    const llm = new RoutingLlm({
      commitment: {
        id: "c1",
        name: "set_reminder",
        input: { text: "Напоминаю: позвонить маме", delay_seconds: 7200 },
      },
    });
    const reminders = new ReminderService(new ReminderStore(dir));
    const deps = makeDeps(llm, userId, {
      reminders,
      speakResult: (reply: AgentReply) => {
        spoken.push(reply.voice);
      },
    });
    return { llm, reminders, deps };
  }

  it("«завтра надо позвонить маме» → напоминание реально поставлено", async () => {
    const spoken: string[] = [];
    const { llm, reminders, deps } = commitmentSetup("u-com-1", spoken);
    try {
      await handleUserText(fakeSession("u-com-1"), "завтра надо позвонить маме", deps);
      // ← без `void reflectCommitmentFromUtterance(...)` стор остаётся пустым
      expect(await waitUntil(() => reminders.list("u-com-1").length > 0)).toBe(true);
      expect(reminders.list("u-com-1")[0]?.text).toBe("Напоминаю: позвонить маме");
      expect(llm.countOf("commitment")).toBe(1);
    } finally {
      reminders.stop();
    }
  });

  it("и ОБЯЗАТЕЛЬНО докладывает владельцу — молчаливых будильников не ставим", async () => {
    const spoken: string[] = [];
    const { reminders, deps } = commitmentSetup("u-com-2", spoken);
    try {
      await handleUserText(fakeSession("u-com-2"), "мне нужно в пятницу оплатить кредит", deps);
      expect(await waitUntil(() => reminders.list("u-com-2").length > 0)).toBe(true);
      // ← подмена onCreated пустышкой оставила бы напоминание, но убила бы доклад владельцу
      expect(await waitUntil(() => spoken.some((s) => /Поставил напоминание/i.test(s)))).toBe(true);
      expect(spoken.find((s) => /Поставил напоминание/i.test(s))).toMatch(/позвонить маме/i);
    } finally {
      reminders.stop();
    }
  });
});

describe("машинный реэнтри (watch-action) рефлекс обязательств НЕ будит", () => {
  it("origin=watch-action напоминания не ставит; ТА ЖЕ фраза от владельца — ставит", async () => {
    const llm = new RoutingLlm({
      commitment: {
        id: "c1",
        name: "set_reminder",
        input: { text: "Напоминаю: позвонить маме", delay_seconds: 7200 },
      },
    });
    const reminders = new ReminderService(new ReminderStore(dir));
    // БЕЗ speakResult: петля идёт синхронно, после await активных задач не остаётся — второй
    // (владельческий) ход не упирается в §20-дубль-гейт и честно доходит до рефлекса.
    const deps = makeDeps(llm, "u-machine", { reminders });
    const session = fakeSession("u-machine");
    try {
      // Поручение сгенерировано СЕРВИСОМ наблюдений — владелец этого вслух не говорил.
      await handleUserText(session, "завтра надо позвонить маме", deps, undefined, { origin: "watch-action" });
      await settle();
      expect(llm.countOf("commitment")).toBe(0); // ← снятый гард !machineTurn провалит это
      expect(reminders.list("u-machine")).toEqual([]);

      // Контроль дискриминации: всё то же самое, отличается ТОЛЬКО origin — рефлекс обязан сработать.
      await handleUserText(session, "завтра надо позвонить маме", deps);
      expect(await waitUntil(() => reminders.list("u-machine").length > 0)).toBe(true);
      expect(llm.countOf("commitment")).toBe(1);
    } finally {
      reminders.stop();
    }
  });
});
