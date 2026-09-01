/**
 * 🔴 ДЫРА В ПРОВОДКЕ: «§14-гейт не пропустил действие» → петля НЕ вправе считать дело сделанным.
 *
 * Живой дефект (Ф0 пульта, адверс-ревью HIGH): decline-ветки гейта возвращают `isError:false` — это
 * не сбой инструмента, владелец просто отказал / не ответил / его не смогли спросить. Петля же
 * взводила `anyMutateSucceeded` на ЛЮБОЙ mutate без ошибки, поэтому «почисти папку загрузок» →
 * `fs_delete` → отказ владельца → ход заканчивался бодрым «Готово, сэр»: masked-failure и
 * анти-капитуляция глохли, задача писалась УСПЕШНОЙ, а не удалено НИЧЕГО. Охраняет ровно одну
 * строку `agent/index.ts` (~2800):
 *   if (r.declined !== true && (!OUTBOUND_SEND_TOOLS.has(tu.name) || r.sent === true)) anyMutateSucceeded = true;
 * Убери из неё `r.declined !== true &&` — весь пакет остаётся зелёным (проверено ревёртом), а Джарвис
 * начинает врать о невыполненном.
 *
 * Почему юнит-тест это НЕ ловит и не мог: `declined` ставит ДИСПЕТЧЕР (`dispatch-util.gateDeclined`),
 * а читает его АГЕНТ-ПЕТЛЯ через две границы — сначала гасит `anyMutateSucceeded`, потом уже терминал
 * считает `maskedFailure` из него и `isHollowSuccess`. Юниты на `gateDeclined` (`declined:true`) и на
 * `isHollowSuccess("Готово.")` проходят и с оборванной проводкой — теряется именно СВЯЗЬ между ними.
 * Это тот же класс, что «мёртвый `gateStoppedRound`» (контроль-3 Ф0): проводку между механизмами
 * проверяем ПЕТЛЁЙ, а не чистыми функциями.
 *
 * Тест ЧЕСТНЫЙ: смотрит на наблюдаемый исход (что Джарвис СКАЗАЛ + состояние задачи в реестре), а не
 * на внутренние флаги и не на текст исходника. Обе полярности обязательны — одобрение владельца в том
 * же сценарии обязано давать НОРМАЛЬНЫЙ успех, иначе тест ловил бы «любой ход провален», а не дыру.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ConfirmOutcomeKind, ConfirmRequest, ConfirmResult } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

/** Сессия с §14-каналом, отвечающим заданным исходом (как настоящий `Session.requestConfirm`). */
function sessionWithConfirm(outcome: ConfirmOutcomeKind) {
  const sendAction = vi.fn((_cmd: ActionCommand, _t?: number) =>
    Promise.resolve({ commandId: "c", ok: true, durationMs: 1 }),
  );
  const requestConfirm = vi.fn(
    (req: ConfirmRequest): Promise<ConfirmResult> =>
      Promise.resolve({ requestId: req.requestId, approved: outcome === "approved", outcome }),
  );
  return {
    sessionId: "s1",
    userId: "u1",
    sendAction,
    send: vi.fn(),
    requestConfirm,
  } as unknown as Session & { sendAction: typeof sendAction; requestConfirm: typeof requestConfirm };
}

function makeDeps(llm: MockLlmProvider, tasks: TaskManager): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks,
  };
}

/**
 * Скрипт одинаков для обеих полярностей: раунд 1 — необратимое удаление под §14-гейтом, раунд 2 —
 * пустое подтверждение «Готово.» (ровно то, чем модель закрывает ход, не разобравшись в исходе).
 * Различается ТОЛЬКО ответ владельца на вопрос гейта.
 */
const deleteThenClaimDone = () =>
  new MockLlmProvider([
    { toolUses: [{ id: "d1", name: "fs_delete", input: { path: "C:/Users/anton/Downloads", recursive: true } }] },
    { text: "Готово." },
    { text: "Готово." }, // страховка: лишний круг петли не должен незаметно «дожать» успех
  ]);

async function runCleanup(outcome: ConfirmOutcomeKind) {
  const llm = deleteThenClaimDone();
  const tasks = new TaskManager();
  const session = sessionWithConfirm(outcome);
  const reply = await handleUserText(session, "почисти папку загрузок", makeDeps(llm, tasks));
  return { reply, tasks, session, llm };
}

describe("§14-гейт остановил mutate → ход НЕ может закончиться «Готово» (проводка declined → петля → терминал)", () => {
  it("ОТКАЗ владельца: терминал честный, задача в реестре — провал, а не успех", async () => {
    const { reply, tasks, session } = await runCleanup("denied");

    // Владелец сказал «нет» — значит ничего не удалено. «Готово» тут было бы ложью.
    expect(reply.voice).not.toMatch(/готов/i);
    expect(reply.voice.toLowerCase()).toContain("не вышло"); // честная формулировка masked-failure
    // Реестр §20 обязан согласоваться с озвученным: провал, а не done.
    const [task] = tasks.list("u1");
    expect(task).toBeDefined();
    expect(task?.state).toBe("failed");
    // И действие ДЕЙСТВИТЕЛЬНО не ушло на ПК — гейт стоит ДО отправки команды.
    expect(session.sendAction).not.toHaveBeenCalled();
  });

  // Второй исход гейта берём именно `expired` («владелец не ответил»), а НЕ `undelivered`: у последнего
  // взводится `channelDown` и петля уходит ждать reconnect (Б4) — терминал там честный по ДРУГОЙ
  // причине (обрыв связи), то есть такой кейс прошёл бы и с оборванной проводкой `declined`.
  it("ВЛАДЕЛЕЦ НЕ ОТВЕТИЛ (окно истекло): то же самое — успехом это не считается", async () => {
    const { reply, tasks, session } = await runCleanup("expired");

    expect(reply.voice).not.toMatch(/готов/i);
    expect(reply.voice.toLowerCase()).toContain("не вышло");
    const [task] = tasks.list("u1");
    expect(task?.state).toBe("failed");
    expect(session.sendAction).not.toHaveBeenCalled();
  });

  it("ОДОБРЕНИЕ владельца: тот же сценарий даёт НОРМАЛЬНЫЙ успех (тест ловит дыру, а не «всё провалено»)", async () => {
    const { reply, tasks, session } = await runCleanup("approved");

    expect(reply.voice).toMatch(/готов/i);
    expect(reply.voice.toLowerCase()).not.toContain("не вышло");
    const [task] = tasks.list("u1");
    expect(task?.state).toBe("done");
    // Одобрено → команда реально ушла на ПК.
    expect(session.sendAction).toHaveBeenCalled();
    expect((session.sendAction.mock.calls[0]?.[0] as ActionCommand | undefined)?.kind).toBe("fs.delete");
  });
});
