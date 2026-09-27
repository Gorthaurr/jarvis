/**
 * W3 (L-2, G-14): code_run с `import jarvis` — это РУКИ в GUI (клики/печать через мост актуаторов), а не
 * самоподтверждающийся код. Проверяем ПЕТЛЁЙ (handleUserText + MockLlm + настоящий dispatchTool):
 *  (а) SDK-скрипт вернул exit 0 → «Готово» без взгляда получает verify-нудж; после look финал принят;
 *  (б) скрипт без jarvis — нуджа нет (защита от перебора: код самоподтверждается выводом);
 *  (в) G-14: SDK-скрипт идёт под арендой ввода — act соседней задачи ждёт конца code.run;
 *  (г) background + jarvis — честный отказ, в раннер ничего не ушло;
 *  (д) SDK-скрипт упал в раннере — исход неизвестен: долг сверки и «СВЕРЬ» в журнале;
 *  (е) самописный инструмент на SDK — та же рука (долг сверки, аренда);
 *  (ж) аренду ждали дольше 10 с — SDK-скрипт, как клик, ждёт свежего взгляда; подсказка — по лестнице восприятия;
 *  (з) сверенный SDK-клик — ДЕЛО сверх запуска: «Запустил доту и нажал…» не гоняет лишний goal-check (launch-claim).
 * Реверт: убери callDrivesInput из isBlindMutateCall (blind-call.ts) — падают (а), (д), (е), (ж); сделай toolNeedsInput
 * по одному имени — падает (в); сними отказ фоновому SDK в code.ts — (г); убери uncertain у ошибки SDK — (д);
 * верни текст гарда «screen_capture / browser_read» — (ж); noteRealAction по одному имени — (з).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { AsyncMutex } from "@jarvis/shared";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { type LlmRequest, MockLlmProvider } from "../../integrations/llm.js";
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

/** Мок, снимающий диалог В МОМЕНТ вызова (петля дописывает тот же массив после — индекс запроса иначе врёт). */
class SnapLlm extends MockLlmProvider {
  readonly snaps: string[] = [];
  override async complete(req: LlmRequest) {
    this.snaps.push(JSON.stringify(req.messages));
    return super.complete(req);
  }
}

const NUDGE = /НЕ проверил исход|НЕ сверил его глазами/u;
/** Сколько verify-нуджей ушло модели за ход (последний запрос несёт весь диалог). */
const nudges = (llm: SnapLlm): number => (llm.snaps.at(-1)?.match(/НЕ проверил исход|НЕ сверил его глазами/gu) ?? []).length;
const everNudged = (llm: SnapLlm): boolean => llm.snaps.some((x) => NUDGE.test(x));
const run = (id: string, code: string, extra: Record<string, unknown> = {}) => ({ id, name: "code_run", input: { lang: "python", code, ...extra } });
const LOOK = { id: "l1", name: "look", input: { what: "elements" } };
const TEXT = "нажми скриптом кнопку играть в доте";

describe("code_run с SDK jarvis — руки, а не самоподтверждающийся код (L-2)", () => {
  it("(а) SDK-скрипт ok → «Готово» без взгляда = verify-нудж; после look финал принят", async () => {
    const llm = new SnapLlm([{ toolUses: [run("c1", SDK)] }, { text: "Готово, сэр." }, { toolUses: [LOOK] }, { text: "Готово, сэр — поиск матча идёт." }]);
    const reply = await handleUserText(session().s, TEXT, deps(llm));
    expect(llm.snaps[1]).not.toMatch(NUDGE);
    expect(llm.snaps[2]).toMatch(NUDGE); // нудж — ровно на «Готово» без взгляда; до фикса оно принималось сразу
    expect(nudges(llm)).toBe(1); // look снял долг — второго нуджа нет
    expect(llm.snaps).toHaveLength(4);
    expect(reply.voice).toMatch(/поиск матча/u);
  });

  it("(з) app_launch → SDK-клик → look → «Запустил доту и нажал…» — дело сверено, goal-check не нужен", async () => {
    const final = "Запустил доту и нажал «Играть», сэр — идёт поиск матча.";
    const llm = new SnapLlm([{ toolUses: [{ id: "l0", name: "app_launch", input: { app: "dota 2" } }] }, { toolUses: [run("c1", SDK)] }, { toolUses: [LOOK] }, { text: final }, { text: final }]);
    await handleUserText(session().s, TEXT, deps(llm));
    expect(llm.snaps.some((x) => x.includes("сверься с ИСХОДНОЙ задачей"))).toBe(false); // до фикса: SDK-клик не «дело»
    expect(llm.snaps).toHaveLength(4);
  });

  it("(б) скрипт без jarvis самоподтверждается выводом — нуджа нет", async () => {
    const llm = new SnapLlm([{ toolUses: [run("c1", PLAIN)] }, { text: "Посчитал, сэр: четыре." }, { text: "Посчитал, сэр: четыре." }]);
    await handleUserText(session(async () => ({ ok: true, data: { stdout: '{"sum": 4}', stderr: "", exitCode: 0 } })).s, "посчитай скриптом два плюс два и сохрани", deps(llm));
    expect(everNudged(llm)).toBe(false);
  });

  it("(д) SDK-скрипт упал в раннере — исход неизвестен: долг сверки, журнал «СВЕРЬ»; ошибка без SDK — без долга", async () => {
    const crash: Reply = async () => ({ ok: false, error: { code: "runtime", message: "код завершился с кодом 1. stderr: Traceback: JarvisError | stdout: clicked" } });
    const llm = new SnapLlm([{ toolUses: [run("c1", SDK)] }, { text: "Скрипт упал на втором шаге, сэр." }, { text: "Скрипт упал, сэр." }, { text: "Скрипт упал, сэр." }]);
    await handleUserText(session(crash).s, TEXT, deps(llm));
    expect(llm.snaps[1]).toMatch(/исход НЕ ПОДТВЕРЖДЁН/u);
    expect(llm.snaps[2]).toMatch(NUDGE); // до фикса: «упал» = ничего не сделано, сверять нечего

    const plain = new SnapLlm([{ toolUses: [run("c1", PLAIN)] }, { text: "Скрипт упал, сэр." }, { text: "Скрипт упал, сэр." }]);
    await handleUserText(session(crash).s, "посчитай скриптом два плюс два и сохрани", deps(plain));
    expect(everNudged(plain)).toBe(false);
  });
});

describe("code_run с SDK jarvis — аренда ввода и фон (G-14)", () => {
  it("(г) background + import jarvis → честный отказ ДО раннера (и в строковой форме флага)", async () => {
    for (const background of [true, "true"] as const) {
      const { s, kinds } = session();
      const llm = new SnapLlm([{ toolUses: [run("c1", SDK, { background })] }, { text: "Фоном нельзя, сэр." }, { text: "Фоном нельзя, сэр." }]);
      await handleUserText(s, TEXT, deps(llm));
      expect(kinds).not.toContain("code.run"); // до фикса: фоновое задание с кликами уходило мимо аренды
      const res = llm.snaps[1] ?? "";
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
    const bg = new Set<Promise<void>>();
    const common = { inputArbiter: arbiter, speakResult: (r: { voice: string }) => void spoken.push(r.voice), bgTasks: bg, tasks: undefined };
    const llm1 = new SnapLlm([{ toolUses: [run("c1", SDK)] }, { toolUses: [LOOK] }, { text: "Готово, сэр." }]);
    const llm2 = new SnapLlm([{ toolUses: [{ id: "a1", name: "act", input: { target: "Настройки", do: "click" } }] }, { text: "Открыл настройки, сэр." }]);
    await handleUserText(s, TEXT, deps(llm1, common));
    await vi.waitFor(() => expect(kinds).toContain("code.run"), { timeout: 3000 });
    await handleUserText(s, "открой вкладку настройки в клиенте доты", deps(llm2, common));
    await vi.waitFor(() => expect(llm2.snaps.length).toBeGreaterThanOrEqual(1), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 80));
    expect(kinds).not.toContain("gui.act"); // до фикса: act уходил сразу — два писателя в GUI

    finishRun({ ok: true, data: OK_RUN });
    await vi.waitFor(() => expect(kinds).toContain("gui.act"), { timeout: 3000 });
    expect(actWhileRunPending).toBe(false);
    await vi.waitFor(() => expect(spoken.length).toBe(2), { timeout: 3000 });
    expect(arbiter.locked).toBe(false); // аренду отдали обе задачи
  });
});

describe("гард протухшего ввода — и для SDK-скрипта (L-2, L-7)", () => {
  afterEach(() => vi.useRealTimers());

  it("(ж) аренда освободилась через 11 с → SDK-скрипт не уходит до взгляда; подсказка: look → web → screen_capture", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let held = false;
    const slowArbiter = {
      get locked() {
        return held;
      },
      acquireWithTimeout: async () => {
        vi.setSystemTime(Date.now() + 11_000); // «другая задача» держала ввод 11 с — экран мог уйти
        held = true;
        return true;
      },
      tryAcquire: () => false,
      release: () => void (held = false),
    } as unknown as AgentDeps["inputArbiter"];
    const { s, kinds } = session();
    const llm = new SnapLlm([{ toolUses: [run("c1", SDK)] }, { toolUses: [LOOK] }, { toolUses: [run("c2", SDK)] }, { toolUses: [LOOK] }, { text: "Готово, сэр." }]);
    await handleUserText(s, TEXT, deps(llm, { inputArbiter: slowArbiter }));
    const first = llm.snaps[1] ?? "";
    expect(first).toMatch(/Ввод освободился только после 11с/u); // до фикса: скрипт кликал по кадру 11-секундной давности
    expect(first.indexOf("look{what:'elements'}")).toBeGreaterThan(0);
    expect(first.indexOf("look{what:'elements'}")).toBeLessThan(first.indexOf("web_read"));
    expect(first.indexOf("web_read")).toBeLessThan(first.indexOf("screen_capture")); // L-7: картинка — последней
    expect(kinds.filter((k) => k === "code.run")).toHaveLength(1); // ушёл только повтор ПОСЛЕ взгляда
    expect(kinds.indexOf("ui.snapshot")).toBeLessThan(kinds.indexOf("code.run"));
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
    const llm = new SnapLlm([{ toolUses: [{ id: "d1", name: "click_play", input: {} }] }, { text: "Готово, сэр." }, { toolUses: [LOOK] }, { text: "Готово, сэр." }]);
    await handleUserText(s, TEXT, deps(llm, { dynamicTools: store }));
    expect(kinds[0]).toBe("code.run"); // самописный реально ушёл в раннер
    expect(llm.snaps[1]).not.toMatch(NUDGE);
    expect(llm.snaps[2]).toMatch(NUDGE);
  });
});
