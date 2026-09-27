/**
 * W3 (L-2, G-14): code_run с `import jarvis` — это РУКИ в GUI (клики/печать через мост актуаторов), а не
 * самоподтверждающийся код. Проверяем ПЕТЛЁЙ (handleUserText + MockLlm + настоящий dispatchTool):
 *  (а) SDK-скрипт вернул exit 0 → «Готово» без взгляда получает verify-нудж; после look финал принят;
 *  (б) скрипт без jarvis — нуджа нет (защита от перебора: код самоподтверждается выводом);
 *  (в) G-14: SDK-скрипт идёт под арендой ввода — act соседней задачи ждёт конца code.run;
 *  (г) background + jarvis — честный отказ, в раннер ничего не ушло;
 *  (д) SDK-скрипт упал в раннере — исход неизвестен: долг сверки и «СВЕРЬ» в журнале;
 *  (е) самописный инструмент на SDK — та же рука (долг сверки, аренда).
 * Реверт: убери callDrivesInput из isBlindMutateCall (blind-call.ts) — падают (а), (д), (е); сделай toolNeedsInput по
 * одному имени — падает (в); сними отказ фоновому SDK в code.ts — падает (г); убери uncertain у ошибки SDK — (д).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { AsyncMutex } from "@jarvis/shared";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { DynamicToolStore } from "../tools/dynamic.js";
import { type AgentDeps, handleUserText } from "./index.js";

const SDK = "import jarvis\njarvis.click('Играть')\nprint('clicked')";
const PLAIN = "import json\nprint(json.dumps({'sum': 2 + 2}))";
const OK_RUN = { stdout: "clicked\n", stderr: "", exitCode: 0 };

type Reply = (cmd: ActionCommand) => Promise<Omit<ActionResult, "commandId" | "durationMs">>;
function session(reply: Reply = async () => ({ ok: true, data: OK_RUN })) {
  const kinds: string[] = [];
  const sendAction = vi.fn(async (cmd: ActionCommand) => {
    kinds.push(cmd.kind);
    if (cmd.kind === "ui.snapshot") return { commandId: "c", ok: true, data: { items: [{ name: "Поиск матча", role: "Text" }] }, durationMs: 1 };
    return { commandId: "c", durationMs: 1, ...(await reply(cmd)) };
  });
  const s = { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
  return { s, kinds, sendAction };
}

function deps(llm: MockLlmProvider, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks: new TaskManager(),
    ...over,
  } as AgentDeps;
}

const NUDGE = /НЕ проверил исход|НЕ сверил его глазами/u;
/** Сколько verify-нуджей ушло модели (последний запрос несёт весь диалог). */
const nudges = (llm: MockLlmProvider): number => (JSON.stringify(llm.requests.at(-1)?.messages ?? []).match(/НЕ проверил исход|НЕ сверил его глазами/gu) ?? []).length;
const run = (id: string, code: string, extra: Record<string, unknown> = {}) => ({ id, name: "code_run", input: { lang: "python", code, ...extra } });
const LOOK = { id: "l1", name: "look", input: { what: "elements" } };
const TEXT = "нажми скриптом кнопку играть в доте";

describe("code_run с SDK jarvis — руки, а не самоподтверждающийся код (L-2)", () => {
  it("(а) SDK-скрипт ok → «Готово» без взгляда = verify-нудж; после look финал принят", async () => {
    const llm = new MockLlmProvider([{ toolUses: [run("c1", SDK)] }, { text: "Готово, сэр." }, { toolUses: [LOOK] }, { text: "Готово, сэр — поиск матча идёт." }]);
    const reply = await handleUserText(session().s, TEXT, deps(llm));
    expect(JSON.stringify(llm.requests[2]?.messages ?? [])).toMatch(NUDGE); // до фикса: «Готово» принималось с первого раза
    expect(nudges(llm)).toBe(1); // look снял долг — второго нуджа нет
    expect(llm.requests).toHaveLength(4);
    expect(reply.voice).toMatch(/поиск матча/u);
  });

  it("(б) скрипт без jarvis самоподтверждается выводом — нуджа нет", async () => {
    const llm = new MockLlmProvider([{ toolUses: [run("c1", PLAIN)] }, { text: "Посчитал, сэр: четыре." }, { text: "Посчитал, сэр: четыре." }]);
    await handleUserText(session(async () => ({ ok: true, data: { stdout: '{"sum": 4}', stderr: "", exitCode: 0 } })).s, "посчитай скриптом два плюс два и сохрани", deps(llm));
    expect(llm.requests.some((r) => NUDGE.test(JSON.stringify(r.messages)))).toBe(false);
  });

  it("(д) SDK-скрипт упал в раннере — исход неизвестен: долг сверки, журнал «СВЕРЬ»; ошибка без SDK — без долга", async () => {
    const crash: Reply = async () => ({ ok: false, error: { code: "runtime", message: "код завершился с кодом 1. stderr: Traceback: JarvisError | stdout: clicked" } });
    const llm = new MockLlmProvider([{ toolUses: [run("c1", SDK)] }, { text: "Скрипт упал на втором шаге, сэр." }, { text: "Скрипт упал, сэр." }, { text: "Скрипт упал, сэр." }]);
    await handleUserText(session(crash).s, TEXT, deps(llm));
    expect(JSON.stringify(llm.requests[1]?.messages ?? [])).toMatch(/исход НЕ ПОДТВЕРЖДЁН/u);
    expect(llm.requests.some((r) => NUDGE.test(JSON.stringify(r.messages)))).toBe(true); // до фикса: «упал» = ничего не сделано

    const plain = new MockLlmProvider([{ toolUses: [run("c1", PLAIN)] }, { text: "Скрипт упал, сэр." }, { text: "Скрипт упал, сэр." }]);
    await handleUserText(session(crash).s, "посчитай скриптом два плюс два и сохрани", deps(plain));
    expect(plain.requests.some((r) => NUDGE.test(JSON.stringify(r.messages)))).toBe(false);
  });
});

describe("code_run с SDK jarvis — аренда ввода и фон (G-14)", () => {
  it("(г) background + import jarvis → честный отказ ДО раннера (и в строковой форме флага)", async () => {
    for (const background of [true, "true"] as const) {
      const { s, kinds } = session();
      const llm = new MockLlmProvider([{ toolUses: [run("c1", SDK, { background })] }, { text: "Фоном нельзя, сэр." }, { text: "Фоном нельзя, сэр." }]);
      await handleUserText(s, TEXT, deps(llm));
      expect(kinds).not.toContain("code.run"); // до фикса: фоновое задание с кликами уходило мимо аренды
      const res = JSON.stringify(llm.requests[1]?.messages ?? []);
      expect(res).toMatch(/фоном НЕ запускается/u);
      expect(res).toMatch(/Ничего не запущено/u);
    }
  });

  it("(в) SDK-скрипт держит аренду: act соседней задачи не уходит, пока идёт code.run", async () => {
    const arbiter = new AsyncMutex();
    let finishRun: (r: { ok: boolean; data?: unknown }) => void = () => undefined;
    let runPending = false;
    let actWhileRunPending: boolean | undefined;
    const { s, kinds } = session(async (cmd) => {
      if (cmd.kind === "code.run") {
        runPending = true;
        return new Promise((res) => (finishRun = (r) => ((runPending = false), res(r))));
      }
      if (cmd.kind === "gui.act") {
        actWhileRunPending ??= runPending;
        return { ok: true, data: { found: { via: "snapshot", name: "Настройки" }, did: "UIA invoke", verified: "met", detail: "ok", observation: { via: "a11y", text: "Настройки открыты", changed: true } } };
      }
      return { ok: true };
    });
    const spoken: string[] = [];
    const bg = new Set<Promise<unknown>>();
    const common = { inputArbiter: arbiter, speakResult: (r: { voice: string }) => void spoken.push(r.voice), bgTasks: bg, tasks: undefined };
    const llm1 = new MockLlmProvider([{ toolUses: [run("c1", SDK)] }, { toolUses: [LOOK] }, { text: "Готово, сэр." }]);
    const llm2 = new MockLlmProvider([{ toolUses: [{ id: "a1", name: "act", input: { target: "Настройки", do: "click" } }] }, { text: "Открыл настройки, сэр." }]);
    await handleUserText(s, TEXT, deps(llm1, common));
    await vi.waitFor(() => expect(kinds).toContain("code.run"), { timeout: 3000 });
    await handleUserText(s, "открой вкладку настройки в клиенте доты", deps(llm2, common));
    await vi.waitFor(() => expect(llm2.requests.length).toBeGreaterThanOrEqual(1), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 80));
    expect(kinds).not.toContain("gui.act"); // до фикса: act уходил сразу — два писателя в GUI

    finishRun({ ok: true, data: OK_RUN });
    await vi.waitFor(() => expect(kinds).toContain("gui.act"), { timeout: 3000 });
    expect(actWhileRunPending).toBe(false);
    await vi.waitFor(() => expect(spoken.length).toBe(2), { timeout: 3000 });
    expect(arbiter.locked).toBe(false); // аренду отдали обе задачи
  });
});

describe("самописный инструмент на SDK — та же рука (L-2/G-14 через реестр владельца)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("(е) click_play (python, import jarvis) → «Готово» без взгляда = verify-нудж", async () => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-dyn-sdk-"));
    const store = new DynamicToolStore(new Set(["code_run"]), { storePath: join(dir, "tools.json") });
    const created = await store.create("u1", { name: "click_play", description: "Жмёт «Играть» в доте", lang: "python", code: SDK });
    expect(created.ok).toBe(true);
    const { s, kinds } = session();
    const llm = new MockLlmProvider([{ toolUses: [{ id: "d1", name: "click_play", input: {} }] }, { text: "Готово, сэр." }, { toolUses: [LOOK] }, { text: "Готово, сэр." }]);
    await handleUserText(s, TEXT, deps(llm, { dynamicTools: store }));
    expect(kinds[0]).toBe("code.run"); // самописный реально ушёл в раннер
    expect(JSON.stringify(llm.requests[2]?.messages ?? [])).toMatch(NUDGE);
  });
});
