/**
 * W2 (П4): три строки мутационной таблицы петли (`scripts/mutate-loop.cjs`), которые на базе W2 не ловил НИ ОДИН тест
 * (выжившие мутации = дыры покрытия; две из них отмечены ещё в W3 как «закрыть тестами ПЕТЛЁЙ»). Каждый кейс — через
 * настоящий `handleUserText`, подменены только клиент (`session.sendAction`) и модель.
 *  1. `sent-required-for-outbound`: отправка человеку «повтор НЕ ушёл» (ok без sent) — не сделанное дело: полое
 *     «Готово» ловится masked-failure, а не звучит успехом;
 *  2. `verified-after-veil-rearm`: действие ушло под вуалью → сверено чистым взглядом → ВТОРОЕ действие снова ушло под
 *     вуалью без сверки → «Готово» звучать не может (старая сверка не покрывает новое действие);
 *  3. `cap-by-loop-iters`: канал ПК раз за разом падает и возвращается — раунды не растут, итерации растут; исчерпанный
 *     кап — честный терминал «слишком много шагов», а не «не вышло»/«готово».
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult, ConfirmRequest, ConfirmResult } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { peerIdentityKeys } from "../messaging/resend-guard.js";
import { resendGuard } from "../tools/handlers/messaging.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

function session(userId: string, reply: (cmd: ActionCommand) => Omit<ActionResult, "commandId" | "durationMs">, channelUp?: () => boolean): Session {
  const sendAction = vi.fn((cmd: ActionCommand) => Promise.resolve({ commandId: "c", durationMs: 1, ...reply(cmd) }));
  const requestConfirm = vi.fn((req: ConfirmRequest): Promise<ConfirmResult> => Promise.resolve({ requestId: req.requestId, approved: true, outcome: "approved" }));
  return { sessionId: `s-${userId}`, userId, sendAction, send: vi.fn(), requestConfirm, ...(channelUp ? { channelUp } : {}) } as unknown as Session;
}

function deps(userId: string, llm: MockLlmProvider, tasks = new TaskManager()): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId,
    tasks,
  };
}

const ok = { ok: true } as const;

describe("дыры мутационной таблицы петли — закрыты петлёй", () => {
  it("sent-required-for-outbound: «повтор НЕ ушёл» + полое «Готово» → честное «не вышло», задача не done", async () => {
    const user = "u-holes-resend";
    const body = "Буду через час, не жди с ужином";
    resendGuard().record(user, "vk", peerIdentityKeys({ names: ["Оля"] }), body); // это уже уходило минуту назад
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "m1", name: "message_send", input: { channel: "vk", to: "Оля", body } }] },
      { text: "Готово, сэр." },
      { text: "Готово, сэр." },
    ]);
    const reply = await handleUserText(session(user, () => ok), "напиши Оле вконтакте, что буду через час", deps(user, llm, tasks));
    expect(reply.voice).not.toMatch(/^Готово/u); // «ok» хендлера не значит «ушло»
    expect(reply.voice).toMatch(/не сработало|Не вышло/u);
    expect(tasks.list(user)[0]?.state).not.toBe("done");
  });

  it("verified-after-veil-rearm: второе действие ушло под вуалью ПОСЛЕ сверки первого → не «Готово», задача провалена", async () => {
    const user = "u-holes-veil";
    const tasks = new TaskManager();
    const batch = (id: string) => ({ id, name: "input_batch", input: { steps: [{ action: "input.key", params: { combo: "Tab" } }, { action: "input.key", params: { combo: "Enter" } }] } });
    const llm = new MockLlmProvider([
      { toolUses: [batch("b1")] }, // шаг 2 ушёл под вуалью, исход неизвестен
      { toolUses: [{ id: "s1", name: "ui_snapshot", input: {} }] }, // чистая сверка: первое действие прошло
      { toolUses: [batch("b2")] }, // снова ушло под вуалью — эту сверку уже никто не делал
      { text: "Готово, сэр." },
      { text: "Готово, сэр." },
    ]);
    const s = session(user, (cmd) =>
      cmd.kind === "skill.execute"
        ? { ok: false, error: { code: "overlay_drawing", message: "шаг 2 (input.key): Поверх экрана открыт оверлей режима выделения" }, stepIndex: 1, stepActionInjected: true }
        : cmd.kind === "ui.snapshot"
          ? { ok: true, data: { items: [{ handle: 1, role: "text", name: "Отправлено" }] } }
          : ok,
    );
    const reply = await handleUserText(s, "отправь форму", deps(user, llm, tasks));
    expect(reply.voice).not.toMatch(/Ушедшее действие я сверил/u); // сверка было ДО второго действия
    expect(tasks.list(user)[0]?.state).toBe("failed");
  });

  it("cap-by-loop-iters: канал падает и возвращается 50 раз — кап итераций исчерпан → честное «слишком много шагов»", async () => {
    const user = "u-holes-cap";
    const tasks = new TaskManager();
    // W2 П5: координаты модели — в кадре (frame); без него сервер отказал бы ДО канала, и кап меряла бы не эта дыра.
    const click = (n: number) => ({ toolUses: [{ id: `c${n}`, name: "input_click", input: { target: { by: "coords", x: 10 + n, y: 20, frame: "f1" } } }] });
    const llm = new MockLlmProvider(Array.from({ length: 60 }, (_, n) => click(n)));
    const s = session(user, () => ({ ok: false, error: { code: "channel_down", message: "канал недоступен" } }), () => true);
    const reply = await handleUserText(s, "ткни по кнопке", deps(user, llm, tasks));
    expect(reply.voice).toMatch(/Слишком много шагов/u); // по раундам (0) кап «не исчерпан» — вышло бы «не вышло»
    expect(tasks.list(user)[0]?.state).toBe("failed");
  }, 30_000);
});
