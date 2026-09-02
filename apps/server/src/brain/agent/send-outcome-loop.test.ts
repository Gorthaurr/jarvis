/**
 * ПРОВОДКА «ok ≠ ушло» ИЗ ПЕТЛИ В ЖУРНАЛ ЧЕКПОЙНТА — тесты против РЕАЛЬНОГО механизма:
 * настоящий `handleUserText`, настоящие хендлеры отправки (`handlers/messaging`), настоящий
 * `CheckpointStore`. Подменён только рубеж клиента (`session.sendAction`) — он и в бою живёт в
 * другом процессе.
 *
 * 🔴 КАКОЙ ЖИВОЙ ДЕФЕКТ ОХРАНЯЕМ. У отправки ЧЕЛОВЕКУ «нет ошибки» ≠ «ушло»: хендлер честно
 * возвращает `ok` на «вы не подтвердили» и «повтор НЕ ушёл», а ФАКТ отправки несёт ОТДЕЛЬНОЕ поле
 * `ToolResult.sent`, которого в convo нет. Волна C (четвёртый контроль, п.31) закрыла это тем, что
 * петля копит `confirmedSends` (tool_use_id с `sent:true`) и отдаёт набор в `buildResumeDigest`.
 * Порвись эта ОДНА связка (`agent/index.ts`: `if (OUTBOUND_SEND_TOOLS.has(tu.name) && r.sent === true)`)
 * — журнал прерванной задачи объявит «— ok» отправку, КОТОРОЙ НЕ БЫЛО, в НЕСОКРАЩАЕМОЙ секции
 * «СДЕЛАНО», и продолжение по «доделай» (правило «не повторяй сделанное») молча её пропустит и
 * отрапортует успех. Обратная поломка не менее опасна: перестань набор наполняться вовсе — журнал
 * скажет «сверь, при необходимости отправь» о РЕАЛЬНО доставленном сообщении, и продолжение пришлёт
 * живому человеку ДУБЛЬ (эпизод «Катя получила дубль»). Поэтому обе стороны здесь под тестом.
 *
 * 🔴 ПОЧЕМУ ЮНИТ-ТЕСТЫ ЭТОГО НЕ ЛОВИЛИ. `checkpoint.test.ts` проверяет САМИ МЕТКИ, передавая наборы
 * `confirmedSends`/`declinedCalls` руками, — то есть контракт форматирования. А наполняются эти
 * наборы в agent-петле из полей `ToolResult`, которые появляются глубоко в хендлере (после §14-гейта,
 * ресенд-гарда и ответа актуатора). Между «хендлер вернул sent» и «журнал напечатал ok» ни один тест
 * не проходил ЦЕЛИКОМ, поэтому точечная поломка проводки оставляла весь пакет зелёным — ровно тот
 * класс, что уже дал мёртвый `gateStoppedRound` (контроль-3 Ф0) и породил правило проекта:
 * проводку между механизмами проверяем ПЕТЛЁЙ.
 *
 * ⚠️ НАЙДЕННЫЙ ПО ХОДУ ДЕФЕКТ (ПОЧИНЕН 2026-09-01, см. последний тест): парная проводка `uncertain`
 * («могло и выполниться») в петле НЕДОСТИЖИМА. `uncertainCalls.add(tu.id)` стоит внутри
 * `if (!r.isError)`, а ЕДИНСТВЕННЫЕ производители флага (`handlers/messaging`, обе ветки «не знаю,
 * ушло ли») возвращают `{...err(...), uncertain: true}`, то есть `isError:true`. Метка
 * «ИСХОД НЕИЗВЕСТЕН» в журнал не попадала НИКОГДА — там стояла «ОШИБКА», которую продолжение читает
 * как «не сделано» и повторяет отправку человеку. Именно от этого дубля флаг и вводился; теперь
 * проверка стоит ДО разветвления по isError, и этот тест держит проводку живой.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult, ConfirmRequest, ConfirmResult } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { type AgentDeps, handleUserText } from "./index.js";

/** Текст отправки — длиннее порога сверки доставки, чтобы путь был реалистичным. */
const BODY = "Буду через час, не жди с ужином";

/**
 * Сессия владельца: подтверждение §14 всегда «да» (гейт согласия нас тут не интересует), а ответ
 * актуатора задаёт тест — это и есть рубеж «сообщение реально ушло / не ушло / неизвестно».
 *
 * ⚠️ Каждому тесту — СВОЙ userId: send-гарды (cadence, ресенд-гард, идемпотентность, согласия)
 * живут в модульных синглтонах и переживают границу теста.
 */
function ownerSession(userId: string, onAction: (cmd: ActionCommand) => ActionResult): Session {
  const sendAction = vi.fn((cmd: ActionCommand, _timeoutMs?: number) => Promise.resolve(onAction(cmd)));
  const requestConfirm = vi.fn(
    (req: ConfirmRequest): Promise<ConfirmResult> =>
      Promise.resolve({ requestId: req.requestId, approved: true, outcome: "approved" }),
  );
  return { sessionId: `s-${userId}`, userId, sendAction, send: vi.fn(), requestConfirm } as unknown as Session;
}

async function makeDeps(userId: string, llm: MockLlmProvider, over: Partial<AgentDeps> = {}): Promise<AgentDeps> {
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

/** Раунд, упирающий проекцию промпта в HARD-порог → петля прерывается и ПИШЕТ журнал. */
const WRAP_ROUND = { toolUses: [{ id: "w1", name: "web_search", input: { query: "цены" } }], usage: { inputTokens: 50_000 } };

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-send-outcome-"));
  // Низкие пороги контекст-окна — дешёвый способ ЧЕСТНО прервать задачу (contextWrap) и получить
  // чекпойнт, не подделывая ни петлю, ни стор.
  process.env.JARVIS_CONTEXT_SOFT_TOKENS = "20000";
  process.env.JARVIS_CONTEXT_HARD_TOKENS = "30000";
});
afterEach(() => {
  delete process.env.JARVIS_CONTEXT_SOFT_TOKENS;
  delete process.env.JARVIS_CONTEXT_HARD_TOKENS;
  rmSync(dir, { recursive: true, force: true });
});

/** Прогнать ход и вернуть журнал сохранённого чекпойнта (null — чекпойнта нет). */
async function runAndReadDigest(
  userId: string,
  utterance: string,
  script: ConstructorParameters<typeof MockLlmProvider>[0],
  onAction: (cmd: ActionCommand) => ActionResult,
): Promise<string | null> {
  const checkpoints = new CheckpointStore(dir);
  const llm = new MockLlmProvider(script);
  await handleUserText(ownerSession(userId, onAction), utterance, await makeDeps(userId, llm, { checkpoints }));
  return checkpoints.peek(userId)?.digest ?? null;
}

/** Актуатор, у которого ВСЁ проходит (сообщение реально доставлено). */
const actuatorOk = (): ActionResult => ({ commandId: "c", ok: true, durationMs: 1 }) as ActionResult;

describe("журнал прерванной задачи знает: у отправки человеку «ok» ≠ «ушло»", () => {
  it("«повтор НЕ ушёл» (ok без sent) помечен «ОТПРАВКА НЕ ПОДТВЕРЖДЕНА», а не «ok»", async () => {
    // Два одинаковых message_send подряд: первый реально уходит (sent), второй ловится ресенд-гардом
    // и возвращает ЧЕСТНЫЙ ok «повтор НЕ ушёл» — без поля sent. Ровно та пара исходов, которую
    // журнал обязан различать.
    const digest = await runAndReadDigest(
      "u-send-not-confirmed",
      "напиши Оле вконтакте, что буду через час",
      [
        { toolUses: [{ id: "m1", name: "message_send", input: { channel: "vk", to: "Оля", body: BODY } }] },
        {
          toolUses: [{ id: "m2", name: "message_send", input: { channel: "vk", to: "Оля", body: BODY } }],
          usage: { inputTokens: 50_000 },
        },
        { text: "не должно вызваться" },
      ],
      actuatorOk,
    );
    expect(digest).not.toBeNull();
    // ← без проводки confirmedSends вторая строка «СДЕЛАНО» тоже стала бы «— ok» (и схлопнулась бы
    // с первой при дедупликации), то есть журнал соврал бы «отправлено дважды».
    expect(digest).toContain("ОТПРАВКА НЕ ПОДТВЕРЖДЕНА");
    // Реальную доставку при этом не оболгали в обратную сторону.
    expect(digest).toMatch(/message_send\([^)]*\) — ok/);
    // Честный текст хендлера доехал до подробной части журнала.
    expect(digest).toContain("повтор НЕ ушёл");
  }, 20_000);

  it("РЕАЛЬНО доставленное сообщение помечено «ok» — продолжение не пришлёт человеку дубль", async () => {
    const digest = await runAndReadDigest(
      "u-send-delivered",
      "напиши Маше вконтакте, что буду через час, и собери цены",
      [
        { toolUses: [{ id: "m1", name: "message_send", input: { channel: "vk", to: "Маша", body: BODY } }] },
        WRAP_ROUND,
        { text: "не должно вызваться" },
      ],
      actuatorOk,
    );
    expect(digest).not.toBeNull();
    // ← перестань петля наполнять confirmedSends (или не отдай набор в журнал) — здесь появилось бы
    // «сверь, при необходимости отправь» о ФАКТИЧЕСКИ доставленном сообщении → дубль живому человеку.
    expect(digest).toMatch(/message_send\([^)]*\) — ok/);
    expect(digest).not.toContain("ОТПРАВКА НЕ ПОДТВЕРЖДЕНА");
  }, 20_000);
});

/**
 * Неопределённый исход отправки: команда ушла на ПК, ответ потерялся, а сверка чтением чата не
 * удалась → `handlers/messaging` возвращает `uncertain:true` («не знаю, ушло ли»).
 */
async function runUncertainSend(userId: string): Promise<string | null> {
  return runAndReadDigest(
    userId,
    "напиши Кате, что буду через час",
    [
      { toolUses: [{ id: "t1", name: "telegram_send", input: { to: "Катя", text: BODY } }] },
      WRAP_ROUND,
      { text: "не должно вызваться" },
    ],
    // Отправка оборвалась по таймауту (НЕ channel_down — иначе сверки не будет), а чтение чата для
    // сверки не удалось → вердикт «unknown».
    (cmd) =>
      cmd.kind === "telegram.send" || cmd.kind === "telegram.read"
        ? ({ commandId: "c", ok: false, durationMs: 1, error: { code: "timeout", message: "нет ответа за 90000ms" } } as ActionResult)
        : actuatorOk(),
  );
}

describe("неопределённый исход отправки в журнале", () => {
  it("НЕ выдаётся за сделанное: «— ok» в секции «СДЕЛАНО» не появляется", async () => {
    const digest = await runUncertainSend("u-send-uncertain-a");
    expect(digest).not.toBeNull();
    expect(digest).toMatch(/telegram_send\(/); // вызов в журнале есть
    expect(digest).not.toMatch(/telegram_send\([^)]*\) — ok/); // но «сделанным» не назван
    // Прозаическое предупреждение хендлера доезжает до подробной части — модель хотя бы там видит,
    // что исход неизвестен.
    expect(digest).toContain("Не знаю, ушло ли");
  }, 20_000);

  /**
   * 🔴 ЭТО БЫЛ ДЕФЕКТ ПРОДАКШН-КОДА — ПОЧИНЕН 2026-09-01 (тест переведён из `it.fails` в обычный).
   *
   * Метка «ИСХОД НЕИЗВЕСТЕН — могло и выполниться; СВЕРЬ … ПЕРЕД повтором» существовала в
   * `outcomeMark` и была покрыта `checkpoint.test.ts`, но в журнал не попадала НИКОГДА: набор
   * `uncertainCalls` наполнялся внутри `if (!r.isError)`, а единственный производитель флага
   * возвращает `{...err(...), uncertain:true}` — то есть ветка была недостижима. В журнале стояла
   * «ОШИБКА», продолжение по «доделай» читало её как «не сделано» и ПОВТОРЯЛО отправку живому
   * человеку — ровно тот дубль, ради которого флаг и вводился.
   *
   * Класс дефекта тот же, что «мёртвый gateStoppedRound» из контроля-3 пульта Ф0: фикс написан,
   * проводки нет, юнит-тесты обеих половин зелёные. Ловится только петлёй — этим тестом.
   */
  it("неопределённая отправка помечается «ИСХОД НЕИЗВЕСТЕН», а не «ОШИБКА»", async () => {
    const digest = await runUncertainSend("u-send-uncertain-b");
    expect(digest).toContain("ИСХОД НЕИЗВЕСТЕН");
    expect(digest).toContain("СВЕРЬ"); // продолжению сказано сверить, а не повторять вслепую
  }, 20_000);

});
