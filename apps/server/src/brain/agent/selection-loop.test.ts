/**
 * §РЕЖИМ ВЫДЕЛЕНИЯ через ПЕТЛЮ (правило аудита тестовой базы: проводку между механизмами проверяем
 * реальным handleUserText, а не чистой функцией — именно там прячутся дефекты, переживающие typecheck
 * и весь зелёный прогон).
 *
 * Что охраняет каждый кейс (и что сломать для реверт-проверки):
 *  1. строка про выделение доезжает до системного хвоста промпта  → убрать slot.selection в agent/index;
 *  2. кадр области доезжает КАРТИНКОЙ, а не base64-текстом       → убрать case в dispatch (generic-путь);
 *  3. выделения нет → честная ОШИБКА инструмента                 → вернуть ok при отсутствии выделения;
 *  4. «посмотрел на выделение и сказал Готово» ≠ успех задачи     → убрать screen_selection из NEUTRAL_TOOLS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore } from "./checkpoint-store.js";
import type { ActionCommand } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { type LlmMessage, MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";
import { SelectionSlot } from "./selection-context.js";

const SEL = { x: 1200, y: 400, w: 640, h: 360, monitorIndex: 1, monitor: "Монитор 2 — 2560×1440 (справа)", createdAt: 1 };

/** Слот выделения, как его заполняет router-ws по client.selection (возраст — по часам сервера). */
function slotWith(sel: typeof SEL | null, ageMs = 42_000): SelectionSlot {
  const slot = new SelectionSlot();
  slot.set(sel, ageMs, Date.now());
  return slot;
}

/** Сессия, отвечающая РЕАЛЬНОЙ формой ActionResult.data клиентского актуатора selection. */
function session(opts: {
  hasSelection: boolean;
  onView?: () => void;
  veil?: boolean;
  batchVeil?: boolean;
  ocrVeil?: boolean;
  /** Контроль-4: первый view под вуалью (overlay_drawing), дальше — обычный кадр. */
  viewVeilOnce?: boolean;
  /** Контроль-4: клиент вернул код вуали с номером шага (реплей дошёл до шага N). */
  veilStepIndex?: number;
  captureVeil?: boolean;
  contextVeil?: boolean;
  /** Контроль-4 (мутация S5): бесшумный ui.invoke прошёл, но fused-наблюдение снято с ОКНА ОВЕРЛЕЯ. */
  invokeVeil?: boolean;
  /** Контроль-4 (мутация S11): OCR под вуалью вернул ПУСТОТУ — состояние системы, не «окно UIA-слепое». */
  ocrVeilEmpty?: boolean;
  /** Контроль-5 (S3): реплей/берст прошёл, но fused-наблюдение снято с ОКНА ОВЕРЛЕЯ. */
  skillObsVeil?: boolean;
  /** Контроль-5 (S1): вуаль поймала РЕТРАЙ/сверку — действие шага stepIndex уже ушло в GUI. */
  veilInjected?: boolean;
  /** Контроль-5 (S2): обычный провал берста с клиентским текстом, уже несущим номер шага. */
  batchFail?: boolean;
  /** Контроль-5 (V4-4): визуальное ожидание под вуалью — met:false, unknown, overlayDrawing. */
  waitVeil?: boolean;
  fsReadFail?: boolean;
  /** Контроль-6 (C5R-1): опрос start под ЕЩЁ открытой вуалью — таймаут ожидания, вуаль стоит. */
  startVeilPoll?: boolean;
  /** Контроль-6 (SR-C6-2): чистый ui.snapshot (без вуали) с элементами — реальная сверка. */
  snapshotClean?: boolean;
  /** Контроль-6 (C5R-6): очередь ответов на skill.execute — по одному на вызов. */
  skillQueue?: Array<{ stepIndex: number; injected?: boolean }>;
  /** Контроль-6 (V5-2): code.run остановлен вуалью после N ушедших действий. */
  codeVeilDone?: number;
  /** Контроль-6 (V5-3): обычный провал реплея с ушедшим действием шага k+1. */
  skillFailInjected?: boolean;
  /** Контроль-7 (sdk-2): фоновый code_run запускается; job.status отдаёт остановку вуалью после 2 действий. */
  jobVeil?: boolean;
  /** Контроль-7 (sdk-3): скрипт перехватил отказ вуали и вышел кодом 0 (клиент: overlayCaught). */
  codeCaught?: boolean;
  /** Контроль-7 (sensors-5): невизуальное ожидание файла с полем veiled от сенсора. */
  waitFileVeiled?: boolean;
  /** Контроль-8: фоновое задание ЗАВЕРШИЛОСЬ успешно (job_status: running:false, exitCode 0). */
  jobDone?: boolean;
  /** Контроль-8: фоновое задание ещё ИДЁТ (job_status: running:true). */
  jobRunning?: boolean;
  /** Контроль-8 (job-status-injected): остановка вуалью с УШЕДШИМ действием последнего шага. */
  jobVeilInjected?: boolean;
  /** Контроль-8 (background-caught-exit0): фоновый скрипт ПЕРЕХВАТИЛ отказ вуали и вышел кодом 0. */
  jobCaught?: boolean;
  /** Контроль-8: клик проваливается обычной ошибкой (мутацию ПРОБОВАЛИ, но не сделали). */
  clickFail?: boolean;
  /** Контроль-8 (browser-open-overlay-code): browser.open отвергнут вуалью на клиенте. */
  browserVeil?: boolean;
  /** Контроль-9: задание легло об вуаль на ПЕРВОМ действии — ни одного ушедшего, ничего не инжектировано. */
  jobVeilDone0?: boolean;
  /** Контроль-9: job_status{kill} — клиент реально убил дерево процессов (killed:true, close ещё не пришёл). */
  jobKilled?: boolean;
  onAction?: (cmd: ActionCommand) => void;
}) {
  let viewsSeen = 0;
  const sendAction = vi.fn((cmd: ActionCommand) => {
    opts.onAction?.(cmd);
    if (opts.startVeilPoll && cmd.kind === "screen.selection" && cmd.op === "start") {
      return Promise.resolve({ commandId: "c", ok: true, data: { started: true, timedOut: true, overlayOpen: true, waitedMs: 5000 }, durationMs: 1 });
    }
    if (opts.snapshotClean && cmd.kind === "ui.snapshot") {
      return Promise.resolve({ commandId: "c", ok: true, data: { items: [{ handle: "1", role: "text", name: "Привет — отправлено" }] }, durationMs: 1 });
    }
    if (opts.skillQueue && cmd.kind === "skill.execute") {
      const next = opts.skillQueue.shift();
      if (next) {
        return Promise.resolve({
          commandId: "c",
          ok: false,
          error: { code: "overlay_drawing" as const, message: `шаг ${next.stepIndex + 1} (input.key): Поверх экрана открыт оверлей режима выделения` },
          stepIndex: next.stepIndex,
          ...(next.injected ? { stepActionInjected: true } : {}),
          durationMs: 1,
        });
      }
    }
    if (typeof opts.codeVeilDone === "number" && cmd.kind === "code.run") {
      return Promise.resolve({
        commandId: "c",
        ok: false,
        error: { code: "overlay_drawing" as const, message: `скрипт остановлен: input.click: Поверх экрана открыт оверлей режима выделения Успешно ушедших действий до остановки: ${opts.codeVeilDone} — они НЕ откатываются.` },
        ...(opts.codeVeilDone > 0 ? { stepIndex: opts.codeVeilDone } : {}),
        durationMs: 1,
      });
    }
    if (opts.clickFail && cmd.kind === "input.click") {
      return Promise.resolve({ commandId: "c", ok: false, error: { code: "runtime" as const, message: "элемент не найден" }, durationMs: 1 });
    }
    if (opts.browserVeil && cmd.kind === "browser.open") {
      return Promise.resolve({ commandId: "c", ok: false, error: { code: "overlay_drawing" as const, message: "Поверх экрана открыт оверлей режима выделения (уже 2 с)" }, durationMs: 1 });
    }
    if ((opts.jobDone || opts.jobRunning || opts.jobVeilInjected || opts.jobCaught) && cmd.kind === "code.run") {
      return Promise.resolve({ commandId: "c", ok: true, data: { jobId: "job-1", pid: 4242, cwd: "C:/", logDir: "x", startedAt: 1, background: true }, durationMs: 1 });
    }
    if (opts.jobDone && cmd.kind === "job.status") {
      return Promise.resolve({ commandId: "c", ok: true, data: { jobId: "job-1", lang: "python", cwd: "C:/", running: false, exitCode: 0, elapsedMs: 900, stdoutTail: "BUILD OK", stderrTail: "", logDir: "x", killed: false }, durationMs: 1 });
    }
    if (opts.jobVeilDone0 && cmd.kind === "code.run") {
      return Promise.resolve({ commandId: "c", ok: true, data: { jobId: "job-1", pid: 4242, cwd: "C:/", logDir: "x", startedAt: 1, background: true }, durationMs: 1 });
    }
    if (opts.jobVeilDone0 && cmd.kind === "job.status") {
      return Promise.resolve({
        commandId: "c",
        ok: true,
        data: { jobId: "job-1", lang: "python", cwd: "C:/", running: false, exitCode: 77, elapsedMs: 900, stdoutTail: "", stderrTail: "[overlay_drawing] done=0 injected=0 input.click: оверлей", logDir: "x", killed: false, overlayStopped: true, overlayReason: "input.click: оверлей", overlayDone: 0 },
        durationMs: 1,
      });
    }
    if (opts.jobKilled && cmd.kind === "job.status") {
      return Promise.resolve({
        commandId: "c",
        ok: true,
        data: { jobId: "job-1", lang: "node", cwd: "C:/", running: true, elapsedMs: 4000, stdoutTail: "compiling", stderrTail: "", logDir: "x", killed: true },
        durationMs: 1,
      });
    }
    if (opts.jobRunning && cmd.kind === "job.status") {
      return Promise.resolve({ commandId: "c", ok: true, data: { jobId: "job-1", lang: "python", cwd: "C:/", running: true, elapsedMs: 900, stdoutTail: "", stderrTail: "", logDir: "x", killed: false }, durationMs: 1 });
    }
    if (opts.jobVeilInjected && cmd.kind === "job.status") {
      return Promise.resolve({
        commandId: "c",
        ok: true,
        data: { jobId: "job-1", lang: "python", cwd: "C:/", running: false, exitCode: 77, elapsedMs: 900, stdoutTail: "typed", stderrTail: "[overlay_drawing] done=2 injected=1 input.type: печать УЖЕ УШЛА", logDir: "x", killed: false, overlayStopped: true, overlayReason: "input.type: печать УЖЕ УШЛА", overlayDone: 2, overlayInjected: true },
        durationMs: 1,
      });
    }
    if (opts.jobCaught && cmd.kind === "job.status") {
      return Promise.resolve({
        commandId: "c",
        ok: true,
        data: { jobId: "job-1", lang: "python", cwd: "C:/", running: false, exitCode: 0, elapsedMs: 900, stdoutTail: "продолжаю", stderrTail: "[overlay_drawing] done=0 injected=0 input.click: оверлей", logDir: "x", killed: false, overlayCaught: true, overlayReason: "input.click: оверлей" },
        durationMs: 1,
      });
    }
    if (opts.jobVeil && cmd.kind === "code.run") {
      return Promise.resolve({ commandId: "c", ok: true, data: { jobId: "job-1", pid: 4242, cwd: "C:/", logDir: "x", startedAt: 1, background: true, note: "фоновое задание запущено; исход НЕ известен" }, durationMs: 1 });
    }
    if (opts.jobVeil && cmd.kind === "job.status") {
      return Promise.resolve({
        commandId: "c",
        ok: true,
        data: { jobId: "job-1", lang: "python", cwd: "C:/", running: false, exitCode: 77, elapsedMs: 900, stdoutTail: "clicked OK\nclicked Send", stderrTail: "[overlay_drawing] done=2 injected=0 input.click: оверлей", logDir: "x", killed: false, overlayStopped: true, overlayReason: "input.click: оверлей", overlayDone: 2 },
        durationMs: 1,
      });
    }
    if (opts.codeCaught && cmd.kind === "code.run") {
      return Promise.resolve({
        commandId: "c",
        ok: true,
        data: { exitCode: 0, stdout: "не удалось, продолжаю", stderr: "[overlay_drawing] done=0 injected=0 input.click: оверлей", truncated: false, overlayCaught: true, overlayReason: "input.click: оверлей", note: "скрипт перехватил отказ вуали" },
        durationMs: 1,
      });
    }
    if (opts.waitFileVeiled && cmd.kind === "wait.for" && (cmd.condition as { kind?: string }).kind === "file") {
      return Promise.resolve({ commandId: "c", ok: true, data: { met: true, elapsedMs: 5, polls: 1, detail: "файл есть", veiled: true }, durationMs: 1 });
    }
    if (opts.skillFailInjected && cmd.kind === "skill.execute") {
      return Promise.resolve({ commandId: "c", ok: false, error: { code: "runtime" as const, message: "шаг 2 (input.key) не подтвердил expect" }, stepIndex: 1, stepActionInjected: true, durationMs: 1 });
    }
    if (opts.viewVeilOnce && cmd.kind === "screen.selection" && cmd.op === "view" && viewsSeen++ === 0) {
      return Promise.resolve({ commandId: "c", ok: false, error: { code: "overlay_drawing" as const, message: "Сейчас идёт рисование: на экране вуаль режима выделения" }, durationMs: 1 });
    }
    if (opts.fsReadFail && cmd.kind === "fs.read") {
      return Promise.resolve({ commandId: "c", ok: false, error: { code: "not_found" as const, message: "ENOENT: файла нет" }, durationMs: 1 });
    }
    if (opts.captureVeil && cmd.kind === "screen.capture") {
      return Promise.resolve({ commandId: "c", ok: true, data: { image: "UE5H", mediaType: "image/png", width: 10, height: 10, overlayDrawing: true, overlayNote: "поверх экрана вуаль режима выделения: кадр затемнён" }, durationMs: 1 });
    }
    if (opts.contextVeil && cmd.kind === "context.read") {
      return Promise.resolve({ commandId: "c", ok: true, data: { text: "Обведите область — Esc отмена", overlayDrawing: true, overlayNote: "поверх экрана вуаль режима выделения" }, durationMs: 1 });
    }
    if (typeof opts.veilStepIndex === "number" && cmd.kind === "skill.execute") {
      return Promise.resolve({ commandId: "c", ok: false, error: { code: "overlay_drawing" as const, message: `шаг ${opts.veilStepIndex} (input.key): Поверх экрана открыт оверлей режима выделения` }, stepIndex: opts.veilStepIndex, durationMs: 1 });
    }
    // Вуаль на экране: физический ввод отклонён кодом overlay_drawing — ЕДИНЫМ кодом обоих клиентских
    // рубежей (ранний гейт dispatch и точка инжекции; контроль-3: ранний гейт раньше отдавал «denied»).
    if (opts.veil && cmd.kind === "input.click") {
      return Promise.resolve({ commandId: "c", ok: false, error: { code: "overlay_drawing" as const, message: "Поверх экрана открыт оверлей режима выделения (уже 2 с) …" }, durationMs: 1 });
    }
    // Реплей/берст под вуалью: skill-runner клиента несёт тот же код (контроль-3; раньше — «runtime»).
    if (opts.batchVeil && cmd.kind === "skill.execute") {
      return Promise.resolve({ commandId: "c", ok: false, error: { code: "overlay_drawing" as const, message: "шаг 0 (input.key): Поверх экрана открыт оверлей режима выделения (уже 2 с) …" }, stepIndex: 0, durationMs: 1 });
    }
    if (opts.skillObsVeil && cmd.kind === "skill.execute") {
      return Promise.resolve({
        commandId: "c",
        ok: true,
        data: { observation: { text: "Обведите область — Esc отмена", weak: false, window: "Jarvis — выделение области", changed: false }, overlayDrawing: true },
        durationMs: 1,
      });
    }
    if (opts.veilInjected && cmd.kind === "skill.execute") {
      return Promise.resolve({
        commandId: "c",
        ok: false,
        error: { code: "overlay_drawing" as const, message: "шаг 2 (input.key): Поверх экрана открыт оверлей режима выделения" },
        stepIndex: 1,
        stepActionInjected: true,
        durationMs: 1,
      });
    }
    if (opts.batchFail && cmd.kind === "skill.execute") {
      return Promise.resolve({ commandId: "c", ok: false, error: { code: "runtime" as const, message: "шаг 3 (input.click): элемент не найден" }, stepIndex: 2, durationMs: 1 });
    }
    if (opts.waitVeil && cmd.kind === "wait.for") {
      return Promise.resolve({ commandId: "c", ok: true, data: { met: false, unknown: true, overlayDrawing: true, overlayNote: "поверх экрана вуаль", veiled: true, elapsedMs: 1, polls: 1, detail: "окна нет" }, durationMs: 1 });
    }
    if (opts.invokeVeil && cmd.kind === "ui.invoke") {
      return Promise.resolve({
        commandId: "c",
        ok: true,
        data: { observation: { text: "Обведите область — Esc отмена", weak: false, window: "Jarvis — выделение области", changed: false }, overlayDrawing: true, overlayNote: "поверх экрана вуаль режима выделения" },
        durationMs: 1,
      });
    }
    if (opts.ocrVeilEmpty && cmd.kind === "screen.ocr") {
      return Promise.resolve({ commandId: "c", ok: true, data: { text: "", lines: [], overlayDrawing: true, overlayNote: "поверх экрана вуаль режима выделения: кадр затемнён" }, durationMs: 1 });
    }
    // OCR под вуалью: клиентский dispatch помечает данные сенсора (контроль-2 (6)).
    if (opts.ocrVeil && cmd.kind === "screen.ocr") {
      return Promise.resolve({
        commandId: "c",
        ok: true,
        data: { text: "Обведите область — Esc отмена", lines: [{ text: "Обведите область", x: 1, y: 1, w: 10, h: 10 }], overlayDrawing: true, overlayNote: "поверх экрана вуаль режима выделения: кадр затемнён" },
        durationMs: 1,
      });
    }
    if (cmd.kind !== "screen.selection") return Promise.resolve({ commandId: "c", ok: true, durationMs: 1 });
    if (cmd.op === "view") opts.onView?.();
    if (cmd.op === "view" && !opts.hasSelection) {
      // Клиент бросает — dispatch клиента маппит это в error.runtime (актуатор не выдумывает область).
      return Promise.resolve({
        commandId: "c",
        ok: false,
        error: { code: "runtime", message: "Владелец сейчас ничего не выделял на экране." },
        durationMs: 1,
      });
    }
    if (cmd.op === "view") {
      return Promise.resolve({
        commandId: "c",
        ok: true,
        data: {
          image: "UE5H",
          mediaType: "image/png",
          width: 640,
          height: 360,
          selection: SEL,
          ageMs: 42_000,
          changedSinceSelection: true,
          crop: { originX: 1200, originY: 400, scale: 1 },
        },
        durationMs: 1,
      });
    }
    return Promise.resolve({ commandId: "c", ok: true, data: { started: true, waiting: true }, durationMs: 1 });
  });
  return { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
}

function deps(llm: MockLlmProvider, selection: boolean | SelectionSlot, tasks = new TaskManager()): AgentDeps {
  const slot = selection instanceof SelectionSlot ? selection : selection ? slotWith(SEL) : undefined;
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks,
    ...(slot ? { selection: slot } : {}),
  };
}

/** Сколько раз в запросе встречается врезка «выделение изменилось» (маркер петли). */
function selectionNotes(messages: LlmMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      if (m.content.includes("ВЫДЕЛЕНИЕ НА ЭКРАНЕ ИЗМЕНИЛОСЬ")) n += 1;
      continue;
    }
    for (const b of m.content) if (b.type === "text" && b.text.includes("ВЫДЕЛЕНИЕ НА ЭКРАНЕ ИЗМЕНИЛОСЬ")) n += 1;
  }
  return n;
}

function imagesInRequest(messages: LlmMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "tool_result" || typeof b.content === "string") continue;
      for (const c of b.content) if (c.type === "image") n += 1;
    }
  }
  return n;
}

/** Помечен ли ХОТЯ БЫ один tool_result ошибкой (is_error) — «честная ошибка» проверяется флагом, не текстом. */
function hasErrorResult(messages: LlmMessage[]): boolean {
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_result" && b.is_error === true) return true;
  }
  return false;
}

/** Текст всех tool_result запроса — там живёт честная ошибка/предупреждение об изменении. */
function toolResultText(messages: LlmMessage[]): string {
  const out: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "tool_result") continue;
      if (typeof b.content === "string") out.push(b.content);
      else for (const c of b.content) if (c.type === "text") out.push(c.text);
    }
  }
  return out.join("\n");
}

const view = (id = "v1") => ({ id, name: "screen_selection", input: { op: "view" } });

describe("режим выделения в петле", () => {
  it("активное выделение попадает в системный хвост промпта — с возрастом и без untrusted-обёртки", async () => {
    const llm = new MockLlmProvider([{ text: "Слушаю, сэр." }]);
    await handleUserText(session({ hasSelection: true }), "что тут не так?", deps(llm, true));
    const dyn = llm.requests[0]?.systemDynamic ?? "";
    expect(dyn).toContain("ПОКАЗЫВАЕТ на область экрана");
    expect(dyn).toContain("640×360");
    expect(dyn).toMatch(/обведена \d+ (?:с|мин|ч) назад/u);
    // Это НАШ статус (координаты нашего же клиента по действию владельца), а не влияемые данные.
    expect(dyn).not.toMatch(/<untrusted_content[^>]*>[^<]*ПОКАЗЫВАЕТ на область/u);
  });

  it("без выделения строки нет — не утверждаем указатель, которого не было", async () => {
    const llm = new MockLlmProvider([{ text: "Слушаю, сэр." }]);
    await handleUserText(session({ hasSelection: false }), "что там на экране?", deps(llm, false));
    expect(llm.requests[0]?.systemDynamic ?? "").not.toContain("ПОКАЗЫВАЕТ на область экрана");
  });

  it("screen_selection{op:view} доезжает КАРТИНКОЙ, с возрастом и предупреждением о смене содержимого", async () => {
    const llm = new MockLlmProvider([{ toolUses: [view()] }, { text: "Вижу, сэр: кнопка съехала." }]);
    await handleUserText(session({ hasSelection: true }), "вот смотри, тут недочёт", deps(llm, true));
    expect(llm.requests.length).toBeGreaterThanOrEqual(2);
    expect(imagesInRequest(llm.requests[1]!.messages)).toBe(1); // без case в dispatch картинки бы не было
    const txt = toolResultText(llm.requests[1]!.messages);
    expect(txt).toContain("[выделенная область]");
    expect(txt).toContain("ИЗМЕНИЛОСЬ"); // честность: под рамкой уже другое
    expect(txt).toContain("screenX = 1200"); // формула клика по увиденному (иначе взгляд — тупик)
  });

  it("выделения нет → инструмент возвращает ОШИБКУ, а не пустой кадр", async () => {
    const llm = new MockLlmProvider([{ toolUses: [view()] }, { text: "Не вижу выделения, сэр — обведите область." }]);
    await handleUserText(session({ hasSelection: false }), "что тут не так?", deps(llm, false));
    const txt = toolResultText(llm.requests[1]!.messages);
    expect(txt).toMatch(/ничего не выделял|Выделение:/u);
    expect(hasErrorResult(llm.requests[1]!.messages)).toBe(true); // ok на отсутствие выделения = ложный успех
    expect(imagesInRequest(llm.requests[1]!.messages)).toBe(0);
  });

  it("НЕИЗМЕННОЕ выделение в многораундовой задаче не впрыскивается ни разу (ревью: строка с возрастом давала врезку каждый раунд)", async () => {
    // Контроль-3: тест был ДЕКОРАТИВЕН — четыре раунда мока укладывались в <1 с, и сравнение ПО СТРОКЕ
    // (дефект (1) первого ревью) тоже давало ноль врезок. Двигаем часы на минуту перед каждым раундом:
    // строка с возрастом («42 с» → «2 мин» → «3 мин») меняется, ключ идентичности — нет.
    const realNow = Date.now;
    let offset = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    try {
      const base = new MockLlmProvider([
        { toolUses: [view("v1")] },
        { toolUses: [{ id: "s1", name: "web_search", input: { query: "как выровнять отступ css" } }] },
        { toolUses: [{ id: "s2", name: "web_search", input: { query: "margin vs padding" } }] },
        { text: "Разобрался, сэр." },
      ]);
      const llm = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
        complete: (req: Parameters<MockLlmProvider["complete"]>[0]) => {
          offset += 61_000;
          return base.complete(req);
        },
        completeStream: (req: Parameters<MockLlmProvider["completeStream"]>[0], onDelta: Parameters<MockLlmProvider["completeStream"]>[1]) => {
          offset += 61_000;
          return base.completeStream(req, onDelta);
        },
      }) as MockLlmProvider;
      await handleUserText(session({ hasSelection: true }), "разберись вот тут с отступом", deps(llm, true));
      expect(base.requests.length).toBeGreaterThanOrEqual(4);
      expect(selectionNotes(base.requests.at(-1)!.messages)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("выделение СМЕНИЛОСЬ посреди задачи → ровно одна врезка, и она называет новую область", async () => {
    const slot = slotWith(SEL);
    const other = { ...SEL, x: 10, y: 20, w: 800, h: 600, createdAt: 2 };
    const llm = new MockLlmProvider([
      { toolUses: [view("v1")] },
      { toolUses: [{ id: "s1", name: "web_search", input: { query: "как выровнять отступ css" } }] },
      { toolUses: [{ id: "s2", name: "web_search", input: { query: "margin vs padding" } }] },
      { text: "Разобрался, сэр." },
    ]);
    // Владелец обвёл ДРУГУЮ область, пока шёл первый раунд (router-ws положил бы её в тот же слот).
    await handleUserText(session({ hasSelection: true, onView: () => slot.set(other, 0, Date.now()) }), "разберись вот тут", deps(llm, slot));
    const last = llm.requests.at(-1)!.messages;
    expect(selectionNotes(last)).toBe(1);
    expect(toolResultText(last) + JSON.stringify(last)).toContain("800×600");
  });

  it("слепой клик + свежий взгляд на выделение = сверка: verify-нуджа нет (view — verify, start/clear — нет)", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "k1", name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } }] },
      { toolUses: [view("v1")] },
      { text: "Готово, сэр: отступ поправлен, на кадре он ровный." },
    ]);
    await handleUserText(session({ hasSelection: true }), "почини вот тут отступ", deps(llm, true));
    // Без классификации по op петля не считала бы view сверкой и слала бы 4-й запрос с verify-нуджем.
    expect(llm.requests.length).toBe(3);
  });

  it("два раунда, отклонённые вуалью оверлея, НЕ эскалируют тир: это состояние системы, а не слабость модели", async () => {
    const click = (id: string) => ({ id, name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } });
    const llm = new MockLlmProvider([{ toolUses: [click("k1")] }, { toolUses: [click("k2")] }, { text: "Подожду, пока закроется оверлей, сэр." }]);
    await handleUserText(session({ hasSelection: true, veil: true }), "почини вот тут отступ", deps(llm, true));
    // Без флага overlayDenied второй провальный раунд подряд уводил бы задачу на fable (ESCALATE_AFTER=2).
    expect(llm.requests.every((r) => r.model !== "f")).toBe(true);
    const txt = toolResultText(llm.requests.at(-1)!.messages);
    expect(txt).toMatch(/оверлей/u); // честная причина дошла до модели
  });

  it("input_batch под вуалью два раунда подряд НЕ эскалирует тир и называет ВУАЛЬ, а не «шаг не прошёл» (контроль-3)", async () => {
    const batch = (id: string) => ({ id, name: "input_batch", input: { steps: [{ action: "input.key", params: { combo: "Enter" } }] } });
    const llm = new MockLlmProvider([{ toolUses: [batch("b1")] }, { toolUses: [batch("b2")] }, { text: "Дождусь закрытия оверлея, сэр." }]);
    await handleUserText(session({ hasSelection: true, batchVeil: true }), "нажми Enter вот тут", deps(llm, true));
    expect(llm.requests.every((r) => r.model !== "f")).toBe(true); // раньше: «runtime» → провал модели → fable
    const txt = toolResultText(llm.requests.at(-1)!.messages);
    expect(txt).toMatch(/вуаль режима выделения/u);
    expect(txt).not.toMatch(/не прошёл/u);
  });

  it("честное «не могу кликнуть — открыт оверлей» после отказа вуали НЕ капитуляция: без нуджа «СДЕЛАЙ» и без fable (контроль-3)", async () => {
    const click = { id: "k1", name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } };
    const llm = new MockLlmProvider([{ toolUses: [click] }, { text: "Не могу кликнуть, сэр: поверх экрана открыт оверлей режима выделения — дождусь, пока вы закончите." }]);
    await handleUserText(session({ hasSelection: true, veil: true }), "почини вот тут отступ", deps(llm, true));
    expect(llm.requests.length).toBe(2); // третий запрос = нудж анти-капитуляции «запрещённый ответ»
    expect(llm.requests.every((r) => r.model !== "f")).toBe(true);
  });

  it("вуаль не дала кликнуть и ничего не сделано → задача в реестре ПРОВАЛЕНА, не done (контроль-3)", async () => {
    const tasks = new TaskManager();
    const click = { id: "k1", name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } };
    const llm = new MockLlmProvider([{ toolUses: [click] }, { text: "Дождусь, пока вы закончите обводить, сэр." }]);
    await handleUserText(session({ hasSelection: true, veil: true }), "почини вот тут отступ", deps(llm, true, tasks));
    const t = tasks.toJSON().tasks[0];
    expect(t?.state).toBe("failed"); // до фикса: done + ok:true при нуле выполненных действий
    expect(t?.lastError ?? "").toMatch(/вуал/u);
  });

  it("сенсор ПОД ВУАЛЬЮ — не сверка: слепой клик + OCR вуали не гасят verify-долг, статус стоит СНАРУЖИ untrusted (контроль-3)", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "k1", name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } }] },
      { toolUses: [{ id: "o1", name: "screen_read_text", input: {} }] },
      { text: "Готово, сэр — отступ поправлен." },
      { text: "Проверил ещё раз, сэр." },
    ]);
    await handleUserText(session({ hasSelection: true, ocrVeil: true }), "почини вот тут отступ", deps(llm, true));
    // Без учёта вуали OCR-текст подсказки оверлея снимал verify-долг, и модель финалила 3-м запросом.
    expect(llm.requests.length).toBeGreaterThanOrEqual(4);
    const txt = toolResultText(llm.requests[2]!.messages);
    expect(txt).toMatch(/СНЯТО ПОД ВУАЛЬЮ/u);
    expect(txt).not.toMatch(/<untrusted_content[^>]*>[^<]*СНЯТО ПОД ВУАЛЬЮ/u);
  });

  it("голосовые «выдели область» / «убери выделение» уходят клиенту с force:true — воля владельца, не модельный start (контроль-3)", async () => {
    const s = session({ hasSelection: true });
    const llm = new MockLlmProvider([{ text: "…" }]);
    await handleUserText(s, "выдели область", deps(llm, true));
    await handleUserText(s, "убери выделение", deps(llm, true));
    const cmds = (s.sendAction as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as ActionCommand);
    expect(cmds).toContainEqual(expect.objectContaining({ kind: "screen.selection", op: "start", force: true }));
    expect(cmds).toContainEqual(expect.objectContaining({ kind: "screen.selection", op: "clear", force: true }));
  });

  it("шесть отказов вуали подряд — НЕ «топтание»: семейный anti-runaway молчит, fable не зовётся (контроль-3)", async () => {
    const clicks = Array.from({ length: 6 }, (_, i) => ({ toolUses: [{ id: `k${i}`, name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } }] }));
    const llm = new MockLlmProvider([...clicks, { text: "Дождусь закрытия оверлея, сэр." }]);
    await handleUserText(session({ hasSelection: true, veil: true }), "почини вот тут отступ", deps(llm, true));
    // До фикса на 6-м отказе прилетал нудж «топтание на месте» + familyBoost на fable — состояние системы
    // читалось как упорство модели.
    expect(llm.requests.every((r) => r.model !== "f")).toBe(true);
    expect(JSON.stringify(llm.requests.at(-1)!.messages)).not.toMatch(/топтание/u);
  });

  // ── контроль-4: признаки вуали не должны ни маскировать чужой провал, ни проваливать чужой успех ──
  it("отказанный ВЗГЛЯД (view под вуалью) + позже верный ответ → задача done, без приписки «не сделал» (контроль-4)", async () => {
    for (const phrase of ["прочитай вот тут текст", "что тут написано?"]) {
      const tasks = new TaskManager();
      const said: string[] = [];
      const llm = new MockLlmProvider([{ toolUses: [view("v1")] }, { toolUses: [view("v2")] }, { text: "Тут написано «Отправить», сэр." }]);
      const sink = { sentence: (x: string) => said.push(x), display: () => undefined, done: () => undefined };
      const reply = await handleUserText(session({ hasSelection: true, viewVeilOnce: true }), phrase, deps(llm, true, tasks), sink);
      const all = `${said.join(" ")} ${reply.voice ?? ""}`;
      expect(all, phrase).not.toMatch(/не сделал/u);
      const t = tasks.toJSON().tasks[0];
      expect(t?.state, phrase).toBe("done"); // до фикса: failed + «вуаль» на верно отвеченный вопрос; V4-5: ассерт безусловный
    }
  });

  it("СМЕШАННЫЙ раунд (клик лёг об вуаль + fs_read ENOENT) — реальная ошибка НЕ маскируется вуалью: §7-эскалация идёт (контроль-4)", async () => {
    const pair = (i: number) => ({
      toolUses: [
        { id: `k${i}`, name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } },
        { id: `r${i}`, name: "fs_read", input: { path: "C:\\nope.txt" } },
      ],
    });
    const llm = new MockLlmProvider([pair(1), pair(2), pair(3), { text: "Не вышло, сэр." }]);
    await handleUserText(session({ hasSelection: true, veil: true, fsReadFail: true }), "прочитай файл и кликни вот тут", deps(llm, true));
    expect(llm.requests.some((r) => r.model === "f")).toBe(true); // до фикса: один overlay_drawing выкидывал весь раунд из эскалации
  });

  it("раунд ОЖИДАНИЯ под вуалью продлевает «остановка вуалью ≠ капитуляция»: клик-вуаль → OCR под вуалью → «дождусь» без нуджа (контроль-4)", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "k1", name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } }] },
      { toolUses: [{ id: "o1", name: "screen_read_text", input: {} }] },
      { text: "Не могу кликнуть, сэр: оверлей всё ещё открыт — дождусь, пока вы закончите." },
    ]);
    await handleUserText(session({ hasSelection: true, veil: true, ocrVeil: true }), "почини вот тут отступ", deps(llm, true));
    // До фикса: (а) снимок гейта жил один раунд → нудж «СДЕЛАЙ» 4-м запросом на fable; (б) goal-check «выполнена
    // ли целиком?» жёг 4-й раунд на честном «не сделал — жду», хотя ответ уже в самом тексте.
    expect(llm.requests.length).toBe(3);
    expect(llm.requests.every((r) => r.model !== "f")).toBe(true);
    expect(JSON.stringify(llm.requests.at(-1)!.messages)).not.toMatch(/запрещённый ответ|сверься с ИСХОДНОЙ/u);
  });

  it("бесшумный ui_invoke под вуалью прошёл, но его fused-наблюдение — окно ОВЕРЛЕЯ: verify-долг не снят, «Готово» получает нудж сверки (контроль-4)", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "i1", name: "ui_invoke", input: { target: { by: "handle", handle: "42" } } }] },
      { text: "Готово, сэр — нажал." },
      { text: "Проверил ещё раз, сэр." },
    ]);
    await handleUserText(session({ hasSelection: true, invokeVeil: true }), "нажми вот тут кнопку", deps(llm, true));
    // Без applyVeil в ветке fused-наблюдения (dispatch generic) observed=true гасил verify-долг → финал 2-м запросом.
    expect(llm.requests.length).toBeGreaterThanOrEqual(3);
    expect(toolResultText(llm.requests[1]!.messages)).toMatch(/СНЯТО ПОД ВУАЛЬЮ/u);
    // Контроль-6 (V5-5): служебный признак клиента — не данные модели: две редакции одного статуса путали её.
    expect(toolResultText(llm.requests[1]!.messages)).not.toMatch(/"overlayDrawing"|"overlayNote"/u);
  });

  it("раунд ожидания = screen_capture под вуалью (0 ошибок) тоже продлевает «остановка вуалью ≠ капитуляция» (контроль-4)", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "k1", name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } }] },
      { toolUses: [{ id: "c1", name: "screen_capture", input: {} }] },
      { text: "Не могу кликнуть, сэр: оверлей всё ещё открыт — дождусь, пока вы закончите." },
    ]);
    await handleUserText(session({ hasSelection: true, veil: true, captureVeil: true }), "почини вот тут отступ", deps(llm, true));
    // Без res.veiled в lookAtScreen кадр под вуалью не считался раундом ожидания → нудж «СДЕЛАЙ» + fable.
    expect(llm.requests.length).toBe(3);
    expect(llm.requests.every((r) => r.model !== "f")).toBe(true);
  });

  it("ПУСТОЙ OCR под вуалью — состояние системы: без приписки «окно UIA-слепое» и без деградации ocr_empty (контроль-4)", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "k1", name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } }] },
      { toolUses: [{ id: "o1", name: "screen_read_text", input: {} }] },
      { text: "Оверлей ещё открыт, сэр — дождусь." },
    ]);
    await handleUserText(session({ hasSelection: true, veil: true, ocrVeilEmpty: true }), "почини вот тут отступ", deps(llm, true));
    const txt = toolResultText(llm.requests[2]!.messages);
    expect(txt).toMatch(/СНЯТО ПОД ВУАЛЬЮ/u);
    expect(txt).not.toMatch(/UIA-слепое/u); // до фикса: пустота под вуалью читалась как промах восприятия
  });

  // ── контроль-5: признак «остановлено вуалью» знает, ЧТО УЖЕ СДЕЛАНО, и не выдаёт give-up за успех ──
  it("взгляд под вуалью + честное «не могу — жду» без единого дела → failed по вуали, не done; приписка не дублирует честный текст (контроль-5 V4-1)", async () => {
    const tasks = new TaskManager();
    const said: string[] = [];
    const llm = new MockLlmProvider([{ toolUses: [{ id: "c1", name: "screen_capture", input: {} }] }, { text: "Не могу править, сэр: открыт оверлей режима выделения — дождусь, пока вы закончите." }]);
    const sink = { sentence: (x: string) => said.push(x), display: () => undefined, done: () => undefined };
    const reply = await handleUserText(session({ hasSelection: true, captureVeil: true }), "почини вот тут отступ", deps(llm, true, tasks), sink);
    const t = tasks.toJSON().tasks[0];
    expect(t?.state).toBe("failed"); // до фикса: done + ok:true + recordOutcome(true) навыку при нуле сделанного
    expect(t?.lastError ?? "").toMatch(/вуаль/u);
    expect(`${said.join(" ")} ${reply.voice ?? ""}`).not.toMatch(/Нужное действие я при этом не сделал/u); // модель уже сказала честно — второй раз не приписываем
  });

  it("skill_execute остановлен вуалью после k=2 шагов → терминал НЕ говорит «не сделал», реестр называет 2 выполненных шага (контроль-5 V4-2)", async () => {
    const tasks = new TaskManager();
    const said: string[] = [];
    const skills = {
      list: async () => [],
      get: async () => ({ id: "sk1", name: "Написать привет", version: 1, steps: [{ action: "input.type", params: { text: "Привет" } }, { action: "input.key", params: { combo: "Enter" } }, { action: "input.key", params: { combo: "Enter" } }], needsReview: false }),
      save: async () => null,
      recall: async () => null,
      recordOutcome: async () => undefined,
    } as unknown as AgentDeps["skills"];
    const llm = new MockLlmProvider([{ toolUses: [{ id: "e1", name: "skill_execute", input: { skillId: "sk1" } }] }, { text: "Первые два шага прошли, сэр: текст напечатан и отправлен; третий выполнить не удалось — открыт оверлей." }]);
    const sink = { sentence: (x: string) => said.push(x), display: () => undefined, done: () => undefined };
    const reply = await handleUserText(session({ hasSelection: true, veilStepIndex: 2 }), "напиши привет вот тут", { ...deps(llm, true, tasks), skills }, sink);
    const all = `${said.join(" ")} ${reply.voice ?? ""}`;
    expect(all).not.toMatch(/Нужное действие я при этом не сделал/u); // Enter уже ушёл — «не сделал» = ложь, ведущая к дублю
    const t = tasks.toJSON().tasks[0];
    expect(t?.state).toBe("failed");
    expect(t?.lastError ?? "").toMatch(/после 2 выполненных/u);
  });

  it("вуаль поймала ретрай: клиент шлёт stepActionInjected → текст «УЖЕ УШЛО … ИСХОД НЕИЗВЕСТЕН», не «повтори»; терминал предупреждает о сверке (контроль-5 S1)", async () => {
    const tasks = new TaskManager();
    const said: string[] = [];
    const skills = {
      list: async () => [],
      get: async () => ({ id: "sk1", name: "Написать привет", version: 1, steps: [{ action: "input.type", params: { text: "Привет" } }, { action: "input.key", params: { combo: "Enter" } }], needsReview: false }),
      save: async () => null,
      recall: async () => null,
      recordOutcome: async () => undefined,
    } as unknown as AgentDeps["skills"];
    const llm = new MockLlmProvider([{ toolUses: [{ id: "e1", name: "skill_execute", input: { skillId: "sk1" } }] }, { text: "Понял, сэр." }]);
    const sink = { sentence: (x: string) => said.push(x), display: () => undefined, done: () => undefined };
    const reply = await handleUserText(session({ hasSelection: true, veilInjected: true }), "напиши привет вот тут", { ...deps(llm, true, tasks), skills }, sink);
    const txt = toolResultText(llm.requests[1]!.messages);
    expect(txt).toMatch(/УЖЕ УШЛО/u);
    expect(txt).toMatch(/ИСХОД НЕИЗВЕСТЕН/u);
    expect(txt).not.toMatch(/и повтори/u);
    // Контроль-6 (C5R-6): одна связная приписка — «следующий шаг ушёл, исход не подтверждён», без «остальное — нет» рядом.
    expect(`${said.join(" ")} ${reply.voice ?? ""}`).toMatch(/исход не подтверждён — перед повтором сверю/u);
    expect(`${said.join(" ")} ${reply.voice ?? ""}`).not.toMatch(/остальное — нет/u);
  });

  it("опрос под вуалью (4× одинаковый wait_for) — ожидание, не «топтание»: без нуджа «ОДНО И ТО ЖЕ», задача не убита runaway (контроль-5 V4-4)", async () => {
    const tasks = new TaskManager();
    const wait = (id: string) => ({ id, name: "wait_for", input: { condition: { kind: "window", titleContains: "Jarvis — выделение области", gone: true }, timeoutMs: 30000 } });
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "k1", name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } }] },
      { toolUses: [wait("w1")] },
      { toolUses: [wait("w2")] },
      { toolUses: [wait("w3")] },
      { toolUses: [wait("w4")] },
      { text: "Оверлей всё ещё открыт, сэр — не могу продолжить, дождусь." },
    ]);
    await handleUserText(session({ hasSelection: true, veil: true, waitVeil: true }), "почини вот тут отступ", deps(llm, true, tasks));
    expect(llm.requests.length).toBe(6); // до фикса: нудж на 3-м, runawayStuck на 4-м
    expect(JSON.stringify(llm.requests.at(-1)!.messages)).not.toMatch(/ОДНО И ТО ЖЕ/u);
    const t = tasks.toJSON().tasks[0];
    expect(t?.lastError ?? "").not.toMatch(/повтор одного действия/u);
    expect(t?.lastError ?? "").toMatch(/вуаль/u);
  });

  it("семь опросов под вуалью — не флуд семейства: без нуджа «топтание», без fable (контроль-5 V4-4b)", async () => {
    const wait = (id: string) => ({ id, name: "wait_for", input: { condition: { kind: "window", titleContains: "Jarvis — выделение области", gone: true }, timeoutMs: 30000 } });
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "k1", name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } }] },
      ...Array.from({ length: 7 }, (_, i) => ({ toolUses: [wait(`w${i}`)] })),
      { text: "Оверлей всё ещё открыт, сэр — не могу продолжить, дождусь." },
    ]);
    await handleUserText(session({ hasSelection: true, veil: true, waitVeil: true }), "почини вот тут отступ", deps(llm, true));
    expect(llm.requests.length).toBe(9);
    expect(llm.requests.every((r) => r.model !== "f")).toBe(true);
    expect(JSON.stringify(llm.requests.at(-1)!.messages)).not.toMatch(/топтание/u);
  });

  it("реплей прошёл, но fused-наблюдение снято с окна оверлея → applyVeil в skills.ts: статус «СНЯТО ПОД ВУАЛЬЮ» у skill_execute и input_batch (контроль-5 S3)", async () => {
    const skills = {
      list: async () => [],
      get: async () => ({ id: "sk1", name: "Написать привет", version: 1, steps: [{ action: "input.type", params: { text: "Привет" } }], needsReview: false }),
      save: async () => null,
      recall: async () => null,
      recordOutcome: async () => undefined,
    } as unknown as AgentDeps["skills"];
    const llm = new MockLlmProvider([{ toolUses: [{ id: "e1", name: "skill_execute", input: { skillId: "sk1" } }] }, { text: "Готово, сэр." }, { text: "Проверил." }]);
    await handleUserText(session({ hasSelection: true, skillObsVeil: true }), "напиши привет вот тут", { ...deps(llm, true), skills });
    expect(toolResultText(llm.requests[1]!.messages)).toMatch(/СНЯТО ПОД ВУАЛЬЮ/u);
    expect(toolResultText(llm.requests[1]!.messages)).not.toMatch(/"overlayDrawing"/u); // контроль-6 (V5-5)
    const llm2 = new MockLlmProvider([{ toolUses: [{ id: "b1", name: "input_batch", input: { steps: [{ action: "input.key", params: { combo: "Enter" } }] } }] }, { text: "Готово, сэр." }, { text: "Проверил." }]);
    await handleUserText(session({ hasSelection: true, skillObsVeil: true }), "нажми Enter вот тут", deps(llm2, true));
    expect(toolResultText(llm2.requests[1]!.messages)).toMatch(/СНЯТО ПОД ВУАЛЬЮ/u);
  });

  it("обычный провал берста: в тексте ОДИН номер шага — клиентский префикс «шаг N (…)» срезается (контроль-5 S2)", async () => {
    const steps = [{ action: "input.type", params: { text: "a" } }, { action: "input.key", params: { combo: "Tab" } }, { action: "input.click", target: { by: "text", text: "OK" } }];
    const llm = new MockLlmProvider([{ toolUses: [{ id: "b1", name: "input_batch", input: { steps } }] }, { text: "Не вышло, сэр." }, { text: "Не вышло, сэр." }, { text: "Не вышло, сэр." }]);
    await handleUserText(session({ hasSelection: true, batchFail: true }), "заполни форму вот тут", deps(llm, true));
    const txt = toolResultText(llm.requests[1]!.messages);
    expect(txt).toMatch(/шаг 3 \(«input\.click»\) не прошёл — элемент не найден/u);
    expect((txt.match(/шаг \d+/gu) ?? []).length).toBe(1);
  });

  it("явный skill_execute под вуалью: два раунда без fable; с номером шага — «шаги УЖЕ ВЫПОЛНЕНЫ», а не «повтори» (контроль-4)", async () => {
    const skills = {
      list: async () => [],
      get: async () => ({ id: "sk1", name: "Написать привет", version: 1, steps: [{ action: "input.type", params: { text: "Привет" } }, { action: "input.key", params: { combo: "Enter" } }, { action: "input.key", params: { combo: "Enter" } }], needsReview: false }),
      save: async () => null,
      recall: async () => null,
      recordOutcome: async () => undefined,
    } as unknown as AgentDeps["skills"];
    const exec = (id: string) => ({ id, name: "skill_execute", input: { skillId: "sk1" } });
    const llm = new MockLlmProvider([{ toolUses: [exec("e1")] }, { toolUses: [exec("e2")] }, { text: "Дождусь закрытия оверлея, сэр." }]);
    await handleUserText(session({ hasSelection: true, veilStepIndex: 2 }), "напиши привет вот тут", { ...deps(llm, true), skills });
    expect(llm.requests.every((r) => r.model !== "f")).toBe(true);
    const txt = toolResultText(llm.requests.at(-1)!.messages);
    expect(txt).toMatch(/шаге 3/u);
    expect(txt).toMatch(/УЖЕ ВЫПОЛНЕНЫ/u);
    expect(txt).not.toMatch(/и повтори/u); // повтор целиком = дубль напечатанного и отправленного
  });

  it("screen_capture под вуалью — не сверка: слепой клик + кадр вуали не гасят verify-долг (контроль-4)", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "k1", name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } }] },
      { toolUses: [{ id: "c1", name: "screen_capture", input: {} }] },
      { text: "Готово, сэр — отступ поправлен." },
      { text: "Проверил ещё раз, сэр." },
    ]);
    await handleUserText(session({ hasSelection: true, captureVeil: true }), "почини вот тут отступ", deps(llm, true));
    expect(llm.requests.length).toBeGreaterThanOrEqual(4);
  });

  it("context_read под вуалью — не сверка, статус снаружи untrusted (контроль-4)", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "k1", name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } }] },
      { toolUses: [{ id: "x1", name: "context_read", input: {} }] },
      { text: "Готово, сэр — отступ поправлен." },
      { text: "Проверил ещё раз, сэр." },
    ]);
    await handleUserText(session({ hasSelection: true, contextVeil: true }), "почини вот тут отступ", deps(llm, true));
    expect(llm.requests.length).toBeGreaterThanOrEqual(4);
    const txt = toolResultText(llm.requests[2]!.messages);
    expect(txt).toMatch(/СНЯТО ПОД ВУАЛЬЮ/u);
    expect(txt).not.toMatch(/<untrusted_content[^>]*>[^<]*СНЯТО ПОД ВУАЛЬЮ/u);
  });

  it("владелец ПОПРАВИЛ цель после отказа вуали → провал по отменённой цели не приписывается новой (контроль-4)", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "k1", name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } }] },
      { text: "В новостях сегодня спокойно, сэр." },
    ]);
    const s = session({
      hasSelection: true,
      veil: true,
      onAction: (cmd) => {
        if (cmd.kind !== "input.click") return;
        const cur = tasks.toJSON().tasks[0];
        if (cur) tasks.steer(cur.taskId, "не надо кликать — просто скажи, что в новостях");
      },
    });
    await handleUserText(s, "кликни вот тут", deps(llm, true, tasks));
    expect(tasks.toJSON().tasks[0]?.state).toBe("done");
  });

  it("навык, поднятый recall'ом, не получает провал за вуаль (контроль-4)", async () => {
    const outcomes: boolean[] = [];
    const skills = {
      list: async () => [],
      get: async () => null,
      save: async () => null,
      recall: async () => ({ id: "sk1", name: "Навык", when: "когда-то", procedure: "шаги", version: 1, recallSim: 0.85, recallSimRaw: 0.8 }),
      recordOutcome: async (_u: string, _id: string, ok: boolean) => {
        outcomes.push(ok);
      },
    } as unknown as AgentDeps["skills"];
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "k1", name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } }] },
      { text: "Не вышло, сэр: открыт оверлей." },
    ]);
    await handleUserText(session({ hasSelection: true, veil: true }), "нажми кнопку играть вот тут", { ...deps(llm, true), skills });
    expect(outcomes).toHaveLength(0); // ни провала, ни успеха: навык не работал, работала вуаль
  });

  it("«посмотрел на выделение и сказал Готово» НЕ считается выполненной задачей (взгляд — не дело)", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([{ toolUses: [view()] }, { text: "Готово." }]);
    const reply = await handleUserText(session({ hasSelection: true }), "почини вот тут отступ", deps(llm, true, tasks), undefined);
    // Классификация NEUTRAL: anyMutateSucceeded не взводится → masked-failure ловит пустое «Готово».
    expect(reply.voice).not.toMatch(/^Готово\.?$/u);
  });
});

// ── контроль-6: признак вуали — по СМЫСЛУ исхода, а не по ВИДУ вызова ──
describe("режим выделения в петле — контроль-6", () => {
  const skillsOf = (steps: Array<Record<string, unknown>>) =>
    ({
      list: async () => [],
      get: async () => ({ id: "sk1", name: "Написать привет", version: 1, steps, needsReview: false }),
      save: async () => null,
      recall: async () => null,
      recordOutcome: async () => undefined,
    }) as unknown as AgentDeps["skills"];
  const twoSteps = [{ action: "input.type", params: { text: "Привет" } }, { action: "input.key", params: { combo: "Enter" } }];

  it("C5R-1: 4× опрос screen_selection{start} под ЕЩЁ открытой вуалью — ожидание владельца, не «топтание»: без нуджа, без runaway, без fable", async () => {
    const tasks = new TaskManager();
    const start = (id: string) => ({ id, name: "screen_selection", input: { op: "start", waitMs: 5000 } });
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "k1", name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } }] },
      { toolUses: [start("s1")] },
      { toolUses: [start("s2")] },
      { toolUses: [start("s3")] },
      { toolUses: [start("s4")] },
      { text: "Оверлей всё ещё открыт, сэр — не могу продолжить, дождусь." },
    ]);
    await handleUserText(session({ hasSelection: false, veil: true, startVeilPoll: true }), "почини вот тут отступ", deps(llm, false, tasks));
    expect(llm.requests.length).toBe(6); // до фикса: нудж «ОДНО И ТО ЖЕ» на 3-м, runawayStuck на 4-м — пока владелец обводил
    expect(llm.requests.every((r) => r.model !== "f")).toBe(true);
    expect(JSON.stringify(llm.requests.at(-1)!.messages)).not.toMatch(/ОДНО И ТО ЖЕ/u);
    const t = tasks.toJSON().tasks[0];
    expect(t?.lastError ?? "").not.toMatch(/повтор одного действия/u);
    expect(t?.lastError ?? "").toMatch(/вуаль/u);
  });

  it("C5R-3: МУТАЦИЯ с наблюдением из окна оверлея (ui_invoke ×6 по одному хендлу) — НЕ «ожидание»: identical-repeat гард жив", async () => {
    const tasks = new TaskManager();
    const inv = (id: string) => ({ id, name: "ui_invoke", input: { target: { by: "handle", handle: "42" } } });
    const llm = new MockLlmProvider([...Array.from({ length: 6 }, (_, i) => ({ toolUses: [inv(`i${i}`)] })), { text: "Готово, сэр." }]);
    await handleUserText(session({ hasSelection: true, invokeVeil: true }), "нажми вот тут кнопку", deps(llm, true, tasks));
    expect(JSON.stringify(llm.requests.map((r) => r.messages))).toMatch(/ОДНО И ТО ЖЕ/u); // до фикса: veiled → «раунд ожидания» → без единого гарда и state:done
    expect(llm.requests.length).toBeLessThan(7);
    expect(tasks.toJSON().tasks[0]?.state).toBe("failed");
  });

  it("SR-C6-2: действие ушло под вуалью, потом модель СВЕРИЛА исход ЧИСТЫМ ui_snapshot — её «отправлено» не переписывается в провал", async () => {
    const tasks = new TaskManager();
    const said: string[] = [];
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "e1", name: "skill_execute", input: { skillId: "sk1" } }] },
      { toolUses: [{ id: "n1", name: "ui_snapshot", input: {} }] },
      { text: "Проверил, сэр: сообщение «Привет» отправлено — оно уже в ленте." },
    ]);
    const sink = { sentence: (x: string) => said.push(x), display: () => undefined, done: () => undefined };
    const reply = await handleUserText(session({ hasSelection: true, veilInjected: true, snapshotClean: true }), "напиши привет вот тут", { ...deps(llm, true, tasks), skills: skillsOf(twoSteps) }, sink);
    const all = `${said.join(" ")} ${reply.voice ?? ""}`;
    expect(tasks.toJSON().tasks[0]?.state).toBe("done"); // до фикса: failed «остановлено вуалью» при сверенном чистым взглядом исходе
    expect(all).not.toMatch(/не подтверждён|не сделал|остальное — нет/u);
  });

  it("C5R-5: durable-дело нейтральным инструментом (memory_write) + честное «посмотреть не могу — оверлей» → done, не failed", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "m1", name: "memory_write", input: { content: "Владелец предпочитает отступ в 4 пробела", kind: "preference" } }] },
      { toolUses: [{ id: "c1", name: "screen_capture", input: {} }] },
      { text: "Запомнил про отступы, сэр. Посмотреть на область сейчас не могу — открыт оверлей режима выделения, дождусь." },
    ]);
    await handleUserText(session({ hasSelection: true, captureVeil: true }), "запомни, что я люблю отступ 4 пробела, и посмотри вот тут", deps(llm, true, tasks));
    const t = tasks.toJSON().tasks[0];
    expect(t?.state).toBe("done"); // до фикса: veilGaveUp → failed «действие не выполнено», хотя память записана
  });

  it("C5R-6: два берста, остановленные вуалью после 3 и 1 шагов → реестр называет ВСЕГО 4, терминал — «Часть шагов (4)»", async () => {
    const tasks = new TaskManager();
    const said: string[] = [];
    const steps = [1, 2, 3, 4].map((i) => ({ action: "input.key", params: { combo: `F${i}` } }));
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "b1", name: "input_batch", input: { steps } }] },
      { toolUses: [{ id: "b2", name: "input_batch", input: { steps: steps.slice(3) } }] },
      { text: "Понял, сэр, дальше пока не продолжаю." },
      { text: "Понял, сэр, дальше пока не продолжаю." }, // ответ на goal-check (два tool-раунда → сверка цели)
    ]);
    const sink = { sentence: (x: string) => said.push(x), display: () => undefined, done: () => undefined };
    const reply = await handleUserText(session({ hasSelection: true, skillQueue: [{ stepIndex: 3 }, { stepIndex: 1 }] }), "нажми клавиши вот тут", deps(llm, true, tasks), sink);
    const t = tasks.toJSON().tasks[0];
    expect(t?.state).toBe("failed");
    expect(t?.lastError ?? "").toMatch(/после 1 выполненных шагов \(всего исполнено 4\)/u); // до фикса: max(3,1)=3 — число, не равное ни последнему, ни сумме
    expect(`${said.join(" ")} ${reply.voice ?? ""}`).toMatch(/Часть шагов \((?:4|четыре)\)/u);
  });

  it("V5-2: code_run остановлен вуалью после 2 ушедших действий → overlayDenied (без fable за два раунда), реестр называет 2 выполненных", async () => {
    const tasks = new TaskManager();
    const code = (id: string) => ({ id, name: "code_run", input: { lang: "python", code: "import jarvis; jarvis.click(1,2)" } });
    const llm = new MockLlmProvider([{ toolUses: [code("c1")] }, { toolUses: [code("c2")] }, { text: "Оверлей открыт, сэр — пока жду его закрытия." }, { text: "Оверлей открыт, сэр — пока жду его закрытия." }]);
    await handleUserText(session({ hasSelection: true, codeVeilDone: 2 }), "кликни вот тут скриптом", deps(llm, true, tasks));
    expect(llm.requests.every((r) => r.model !== "f")).toBe(true); // до фикса: «code.run не удалось: overlay_drawing» = провал модели ×2 → эскалация
    const txt = toolResultText(llm.requests[1]!.messages);
    expect(txt).not.toMatch(/не удалось/u);
    expect(txt).toMatch(/остановлен/u);
    const t = tasks.toJSON().tasks[0];
    expect(t?.state).toBe("failed");
    expect(t?.lastError ?? "").toMatch(/после 2 выполненных/u);
  });

  it("V5-3: обычный провал skill_execute на шаге 2 с ушедшим действием → «выполнено 1 из 2», «НЕ откатываются», «ИСХОД НЕ ПОДТВЕРЖДЁН», один номер шага", async () => {
    const llm = new MockLlmProvider([{ toolUses: [{ id: "e1", name: "skill_execute", input: { skillId: "sk1" } }] }, { text: "Не вышло, сэр." }, { text: "Не вышло, сэр." }, { text: "Не вышло, сэр." }]);
    await handleUserText(session({ hasSelection: true, skillFailInjected: true }), "напиши привет вот тут", { ...deps(llm, true), skills: skillsOf(twoSteps) });
    const txt = toolResultText(llm.requests[1]!.messages);
    expect(txt).toMatch(/выполнено 1 из 2, шаг 2 \(«input\.key»\) не прошёл — не подтвердил expect/u); // до фикса: «Навык … не выполнен: runtime …» → повтор всего навыка
    expect(txt).toMatch(/Сделанные 1 шагов НЕ откатываются/u);
    expect(txt).toMatch(/ИСХОД НЕ ПОДТВЕРЖДЁН/u);
    expect((txt.match(/шаг \d+/gu) ?? []).length).toBe(1);
    expect(txt).not.toMatch(/не выполнен:/u);
  });

  describe("C5R-4: частично исполненный реплей доходит до ЖУРНАЛА чекпойнта", () => {
    let dir = "";
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "jarvis-sel-cp-"));
      process.env.JARVIS_CONTEXT_SOFT_TOKENS = "20000";
      process.env.JARVIS_CONTEXT_HARD_TOKENS = "30000";
    });
    afterEach(() => {
      delete process.env.JARVIS_CONTEXT_SOFT_TOKENS;
      delete process.env.JARVIS_CONTEXT_HARD_TOKENS;
      rmSync(dir, { recursive: true, force: true });
    });

    it("skill_execute, остановленный вуалью после 1 шага с ушедшим Enter, в «СДЕЛАНО» — «ЧАСТИЧНО … УШЛО … СВЕРЬ», а не «ОШИБКА»", async () => {
      const checkpoints = new CheckpointStore(dir);
      const llm = new MockLlmProvider([
        { toolUses: [{ id: "e1", name: "skill_execute", input: { skillId: "sk1" } }] },
        { toolUses: [{ id: "w1", name: "web_search", input: { query: "x" } }], usage: { inputTokens: 50_000 } },
        { text: "не должно вызваться" },
      ]);
      await handleUserText(session({ hasSelection: true, veilInjected: true }), "напиши привет вот тут и найди рецепт", { ...deps(llm, true), skills: skillsOf(twoSteps), checkpoints });
      const cp = checkpoints.peek("u1");
      expect(cp).not.toBeNull();
      expect(cp?.digest).toMatch(/skill_execute\([^)]*\) — ЧАСТИЧНО — шаги 1\.\.1 УЖЕ ВЫПОЛНЕНЫ/u); // до фикса: «— ОШИБКА» → «доделай» повторял напечатанное и Enter
      expect(cp?.digest).toMatch(/действие шага 2 УШЛО/u);
      expect(cp?.digest).not.toMatch(/skill_execute\([^)]*\) — ОШИБКА/u);
    });

    it("V5-3: ОБЫЧНЫЙ провал реплея с ушедшим действием → в журнале «ИСХОД НЕИЗВЕСТЕН» (uncertain), а не «ОШИБКА»", async () => {
      const checkpoints = new CheckpointStore(dir);
      const llm = new MockLlmProvider([
        { toolUses: [{ id: "e1", name: "skill_execute", input: { skillId: "sk1" } }] },
        { toolUses: [{ id: "w1", name: "web_search", input: { query: "x" } }], usage: { inputTokens: 50_000 } },
        { text: "не должно вызваться" },
      ]);
      await handleUserText(session({ hasSelection: true, skillFailInjected: true }), "напиши привет вот тут и найди рецепт", { ...deps(llm, true), skills: skillsOf(twoSteps), checkpoints });
      const cp = checkpoints.peek("u1");
      // Контроль-8 (step-failure-journal): метка стала СИЛЬНЕЕ — теперь журнал называет и k исполненных шагов,
      // и ушедшее действие (раньше здесь стояло общее «ИСХОД НЕИЗВЕСТЕН», а k терялся).
      expect(cp?.digest).toMatch(/skill_execute\([^)]*\) — ЧАСТИЧНО — шаги 1\.\.1 УЖЕ ВЫПОЛНЕНЫ/u);
      expect(cp?.digest).toMatch(/действие шага 2 УШЛО/u);
      expect(cp?.digest).not.toMatch(/skill_execute\([^)]*\) — ОШИБКА/u);
    });

    it("контроль-7 loop-1: ПРАВКА ЦЕЛИ на ходу не стирает partialCalls — журнал после обрыва по-прежнему «ЧАСТИЧНО», не «ОШИБКА»", async () => {
      const checkpoints = new CheckpointStore(dir);
      const tasks = new TaskManager();
      const llm = new MockLlmProvider([
        { toolUses: [{ id: "e1", name: "skill_execute", input: { skillId: "sk1" } }] },
        { toolUses: [{ id: "w1", name: "web_search", input: { query: "x" } }], usage: { inputTokens: 50_000 } },
        { text: "не должно вызваться" },
      ]);
      const s = session({
        hasSelection: true,
        veilInjected: true,
        onAction: (cmd) => {
          if (cmd.kind === "skill.execute") {
            const cur = tasks.activeForUser("u1")[0];
            if (cur) tasks.steer(cur.taskId, "и ещё найди рецепт борща"); // владелец поправил цель, пока шёл реплей
          }
        },
      });
      await handleUserText(s, "напиши привет вот тут", { ...deps(llm, true, tasks), skills: skillsOf(twoSteps), checkpoints });
      const cp = checkpoints.peek("u1");
      expect(cp).not.toBeNull();
      expect(cp?.digest).toMatch(/skill_execute\([^)]*\) — ЧАСТИЧНО — шаги 1\.\.1 УЖЕ ВЫПОЛНЕНЫ/u); // до фикса: steer чистил partialCalls → «ОШИБКА»
      expect(cp?.digest).not.toMatch(/skill_execute\([^)]*\) — ОШИБКА/u);
    });
  });

  it("контроль-7 loop-2: сверка чистым взглядом относится к ПРЕЖНЕМУ ушедшему действию — новый отказ вуалью (ничего не сделано) не едет под ней в done", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "e1", name: "skill_execute", input: { skillId: "sk1" } }] },
      { toolUses: [{ id: "n1", name: "ui_snapshot", input: {} }] },
      { toolUses: [{ id: "k1", name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } }] },
      { text: "Готово, сэр." },
      { text: "Готово, сэр." },
    ]);
    await handleUserText(session({ hasSelection: true, veilInjected: true, snapshotClean: true, veil: true }), "напиши привет вот тут и кликни", { ...deps(llm, true, tasks), skills: skillsOf(twoSteps) });
    expect(tasks.toJSON().tasks[0]?.state).toBe("failed"); // до фикса: липкий verifiedAfterVeil → done при невыполненном клике
  });

  it("контроль-7 loop-3: полое «Сделано» при 3 исполненных шагах и ушедшем Enter → честный overlay-терминал (k и «ушёл»), а не «инструменты не отработали»", async () => {
    const tasks = new TaskManager();
    const said: string[] = [];
    const steps = [1, 2, 3, 4].map((i) => ({ action: "input.key", params: { combo: `F${i}` } }));
    const llm = new MockLlmProvider([{ toolUses: [{ id: "b1", name: "input_batch", input: { steps } }] }, { text: "Сделано, сэр." }]);
    const sink = { sentence: (x: string) => said.push(x), display: () => undefined, done: () => undefined };
    const reply = await handleUserText(session({ hasSelection: true, skillQueue: [{ stepIndex: 3, injected: true }] }), "нажми клавиши вот тут", deps(llm, true, tasks), sink);
    const all = `${said.join(" ")} ${reply.voice ?? ""}`;
    const t = tasks.toJSON().tasks[0];
    expect(t?.state).toBe("failed");
    expect(t?.lastError ?? "").toMatch(/после 3 выполненных шагов/u); // до фикса: «инструменты не отработали»
    expect(all).toMatch(/исход не подтверждён — перед повтором сверю/u);
    expect(all).not.toMatch(/не сработало|Сделано/u); // полое «Сделано» модели терминал не переиспользует
  });

  it("контроль-7 sdk-2: фоновое задание, легшее об вуаль, — job_status структурно overlayDenied; запуск скрипта не считается сделанным делом", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "c1", name: "code_run", input: { lang: "python", code: "import jarvis", background: true } }] },
      { toolUses: [{ id: "j1", name: "job_status", input: { jobId: "job-1" } }] },
      { text: "Не могу продолжить, сэр: скрипт остановился на третьем клике — открыт оверлей; два клика ушли, дождусь." },
    ]);
    await handleUserText(session({ hasSelection: true, jobVeil: true }), "кликни вот тут скриптом в фоне", deps(llm, true, tasks));
    expect(toolResultText(llm.requests[2]!.messages)).toMatch(/ОСТАНОВЛЕНО вуалью/u);
    const t = tasks.toJSON().tasks[0];
    expect(t?.state).toBe("failed"); // до фикса: запуск = anyMutateSucceeded, job_status = обычный JSON → done
    expect(t?.lastError ?? "").toMatch(/после 2 выполненных/u);
    expect(llm.requests.every((r) => r.model !== "f")).toBe(true);
  });

  it("контроль-7 sdk-3: скрипт перехватил отказ вуали и вышел кодом 0 → исход НЕ ПОДТВЕРЖДЁН, полое «Готово» не проходит успехом", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([{ toolUses: [{ id: "c1", name: "code_run", input: { lang: "python", code: "try:\n jarvis.click(1,2)\nexcept: pass" } }] }, { text: "Готово, сэр." }]);
    await handleUserText(session({ hasSelection: true, codeCaught: true }), "кликни вот тут скриптом", deps(llm, true, tasks));
    expect(toolResultText(llm.requests[1]!.messages)).toMatch(/ПЕРЕХВАТИЛ отказ вуали/u);
    expect(tasks.toJSON().tasks[0]?.state).toBe("failed"); // до фикса: exit 0 = mutate ok → done без единого клика
  });

  it("контроль-7 sensors-5: невизуальное wait_for{file} с полем veiled от сенсора — ни «СНЯТО ПОД ВУАЛЬЮ», ни служебных полей в тексте", async () => {
    const llm = new MockLlmProvider([{ toolUses: [{ id: "w1", name: "wait_for", input: { condition: { kind: "file", path: "C:/out.txt" }, timeoutMs: 1000 } }] }, { text: "Файл появился, сэр." }]);
    await handleUserText(session({ hasSelection: true, waitFileVeiled: true }), "дождись файла и скажи", deps(llm, true));
    const txt = toolResultText(llm.requests[1]!.messages);
    expect(txt).toMatch(/"met":true/u);
    expect(txt).not.toMatch(/ВУАЛЬЮ|"veiled"|"overlayDrawing"/u); // до фикса: {"met":true,…,"veiled":true} внутри untrusted
  });
});

// ── контроль-8: признак по СМЫСЛУ исхода; частичное исполнение не теряется ни в одной ветке ──
describe("режим выделения в петле — контроль-8", () => {
  const skillsOf8 = (steps: Array<Record<string, unknown>>) =>
    ({
      list: async () => [],
      get: async () => ({ id: "sk1", name: "Написать привет", version: 1, steps, needsReview: false }),
      save: async () => null,
      recall: async () => null,
      recordOutcome: async () => undefined,
    }) as unknown as AgentDeps["skills"];
  const twoSteps8 = [{ action: "input.type", params: { text: "Привет" } }, { action: "input.key", params: { combo: "Enter" } }];
  /**
   * Аренда ввода, которую держит ДРУГАЯ задача Джарвиса. ⚠️ Аренда берётся ОДИН раз на задачу
   * (`ensureInput`: `if (holdsInput) return true`), поэтому «берст успел, а следующий клик не пустили» в одной
   * задаче недостижимо. Реальное сосуществование двух причин — ФОНОВОЕ задание: оно аренды не берёт (code.run не
   * GUI), делает свои клики через мост клиента и ложится об вуаль, а следующий input_click упирается в занятый ввод.
   */
  const busyArbiter = () =>
    ({
      locked: true,
      acquireWithTimeout: async () => false,
      acquire: async () => undefined,
      release: () => undefined,
    }) as unknown as AgentDeps["inputArbiter"];

  it("job-status-not-mutate: остановку вуалью доложил НЕЙТРАЛЬНЫЙ job_status — при финале «Готово» это провал с ЧЕСТНЫМ числом шагов, не «инструменты не отработали»", async () => {
    const tasks = new TaskManager();
    const said: string[] = [];
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "c1", name: "code_run", input: { lang: "python", code: "import jarvis", background: true } }] },
      { toolUses: [{ id: "j1", name: "job_status", input: { jobId: "job-1" } }] },
      { text: "Готово, сэр." },
      { text: "Готово, сэр." },
    ]);
    const sink = { sentence: (x: string) => said.push(x), display: () => undefined, done: () => undefined };
    const reply = await handleUserText(session({ hasSelection: true, jobVeil: true }), "кликни вот тут скриптом в фоне", deps(llm, true, tasks), sink);
    const t = tasks.toJSON().tasks[0];
    expect(t?.state).toBe("failed");
    expect(t?.lastError ?? "").toMatch(/после 2 выполненных/u); // до фикса: overlayDeniedAny не взводился (job_status нейтрален)
    expect(`${said.join(" ")} ${reply.voice ?? ""}`).not.toMatch(/не сработало/u); // и не «инструменты не отработали»
  });

  it("job-status-double-count: повторный опрос ОДНОГО задания не складывается сам с собой — «после 2 выполненных», а не «всего исполнено 4»", async () => {
    const tasks = new TaskManager();
    const status = (id: string) => ({ id, name: "job_status", input: { jobId: "job-1" } });
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "c1", name: "code_run", input: { lang: "python", code: "import jarvis", background: true } }] },
      { toolUses: [status("j1")] },
      { toolUses: [status("j2")] },
      { text: "Не могу продолжить, сэр: оверлей всё ещё открыт — дождусь." },
    ]);
    await handleUserText(session({ hasSelection: true, jobVeil: true }), "кликни вот тут скриптом в фоне", deps(llm, true, tasks));
    const t = tasks.toJSON().tasks[0];
    expect(t?.lastError ?? "").toMatch(/после 2 выполненных/u);
    expect(t?.lastError ?? "").not.toMatch(/всего исполнено/u); // до фикса: += на каждый опрос → «всего исполнено 4»
  });

  it("job-status-injected: «действие последнего шага УЖЕ УШЛО» доезжает от фонового задания до текста и журнала", async () => {
    const tasks = new TaskManager();
    const said: string[] = [];
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "c1", name: "code_run", input: { lang: "python", code: "import jarvis", background: true } }] },
      { toolUses: [{ id: "j1", name: "job_status", input: { jobId: "job-1" } }] },
      { text: "Понял, сэр." },
      { text: "Понял, сэр." },
    ]);
    const sink = { sentence: (x: string) => said.push(x), display: () => undefined, done: () => undefined };
    const reply = await handleUserText(session({ hasSelection: true, jobVeilInjected: true }), "напечатай вот тут скриптом в фоне", deps(llm, true, tasks), sink);
    expect(toolResultText(llm.requests[2]!.messages)).toMatch(/УЖЕ УШЛО/u); // до фикса: v.injected выбрасывался клиентом
    const all = `${said.join(" ")} ${reply.voice ?? ""}`;
    expect(all).toMatch(/исход не подтверждён/u);
    expect(all).not.toMatch(/остальное — нет/u);
  });

  it("background-job-no-success: успешно завершённое фоновое задание — сделанное дело, а не «инструменты не отработали»", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "c1", name: "code_run", input: { lang: "node", code: "build()", background: true } }] },
      { toolUses: [{ id: "j1", name: "job_status", input: { jobId: "job-1" } }] },
      { text: "Готово, сэр." },
      { text: "Готово, сэр." },
    ]);
    await handleUserText(session({ hasSelection: false, jobDone: true }), "запусти сборку в фоне", deps(llm, false, tasks));
    expect(tasks.toJSON().tasks[0]?.state).toBe("done"); // до фикса: masked-failure → failed при реально собранном проекте
  });

  it("background-job-no-success (2): «задание ещё выполняется» — не капитуляция: без нуджа «не сдавайся» и без fable", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "c1", name: "code_run", input: { lang: "node", code: "build()", background: true } }] },
      { toolUses: [{ id: "j1", name: "job_status", input: { jobId: "job-1" } }] },
      { text: "Пока не могу сказать, сэр: задание ещё выполняется." },
    ]);
    await handleUserText(session({ hasSelection: false, jobRunning: true }), "запусти сборку в фоне", deps(llm, false));
    expect(llm.requests.length).toBe(3); // до фикса: 4-й раунд — нудж анти-капитуляции
    expect(llm.requests.every((r) => r.model !== "f")).toBe(true);
    expect(JSON.stringify(llm.requests.at(-1)!.messages)).not.toMatch(/не сдавайся|СТОП/u);
  });

  it("background-caught-exit0: фоновый скрипт перехватил отказ вуали и вышел кодом 0 → исход НЕ ПОДТВЕРЖДЁН, «Готово» не проходит успехом", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "c1", name: "code_run", input: { lang: "python", code: "try:\n jarvis.click(1,2)\nexcept: pass", background: true } }] },
      { toolUses: [{ id: "j1", name: "job_status", input: { jobId: "job-1" } }] },
      { text: "Готово, сэр." },
      { text: "Готово, сэр." },
    ]);
    await handleUserText(session({ hasSelection: true, jobCaught: true }), "кликни вот тут скриптом в фоне", deps(llm, true, tasks));
    expect(toolResultText(llm.requests[2]!.messages)).toMatch(/ПЕРЕХВАТИЛО отказ вуали/u);
    expect(tasks.toJSON().tasks[0]?.state).toBe("failed"); // до фикса: exitCode 0 читался чистым успехом
  });

  it("verified-after-veil-rearm: чистый взгляд ПОСЛЕ отказа вуали, при котором ничего не ушло, не «удостоверяет» ход", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "e1", name: "skill_execute", input: { skillId: "sk1" } }] },
      {
        toolUses: [
          { id: "k1", name: "input_click", input: { target: { by: "coords", x: 1300, y: 500 } } },
          { id: "n1", name: "ui_snapshot", input: {} },
        ],
      },
      { text: "Готово, сэр." },
      { text: "Готово, сэр." },
    ]);
    await handleUserText(session({ hasSelection: true, veilInjected: true, veil: true, snapshotClean: true }), "напиши привет вот тут и кликни", { ...deps(llm, true, tasks), skills: skillsOf8(twoSteps8) });
    expect(tasks.toJSON().tasks[0]?.state).toBe("failed"); // до фикса: ui_snapshot взводил verifiedAfterVeil обратно → done
  });

  it("input-denied-shadows-overlay: занятая аренда ввода не прячет 3 исполненных шага и ушедшее действие", async () => {
    const tasks = new TaskManager();
    const said: string[] = [];
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "c1", name: "code_run", input: { lang: "python", code: "import jarvis", background: true } }] },
      { toolUses: [{ id: "j1", name: "job_status", input: { jobId: "job-1" } }] },
      { toolUses: [{ id: "k1", name: "input_click", input: { target: { by: "coords", x: 10, y: 20 } } }] },
      { text: "Понял, сэр." },
      { text: "Понял, сэр." },
    ]);
    const sink = { sentence: (x: string) => said.push(x), display: () => undefined, done: () => undefined };
    const reply = await handleUserText(
      session({ hasSelection: true, jobVeilInjected: true }),
      "кликни вот тут скриптом, потом нажми кнопку",
      { ...deps(llm, true, tasks), inputArbiter: busyArbiter() },
      sink,
    );
    const t = tasks.toJSON().tasks[0];
    expect(t?.state).toBe("failed");
    expect(t?.lastError ?? "").toMatch(/после 2 выполненных шагов/u); // до фикса: «ввод занят другой задачей — действие не выполнено»
    expect(t?.lastError ?? "").toMatch(/ввод при этом был занят/u); // обе причины названы
    expect(`${said.join(" ")} ${reply.voice ?? ""}`).not.toMatch(/Нужное действие я при этом не сделал/u);
  });

  it("durable-neutral-masked: durable-дело нейтральным инструментом + дворецкое «Готово» — не «Не вышло»; попытка мутации возвращает строгость", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "m1", name: "memory_write", input: { content: "Владелец работает по ночам", kind: "fact" } }] },
      { text: "Готово, сэр." },
      { text: "Готово, сэр." },
    ]);
    await handleUserText(session({ hasSelection: false }), "запомни, что я работаю по ночам", deps(llm, false, tasks));
    expect(tasks.toJSON().tasks[0]?.state).toBe("done"); // до фикса: masked-failure → «Не вышло» при записанном факте

    const tasks2 = new TaskManager();
    const llm2 = new MockLlmProvider([
      {
        toolUses: [
          { id: "m2", name: "memory_write", input: { content: "Владелец работает по ночам", kind: "fact" } },
          { id: "k2", name: "input_click", input: { target: { by: "coords", x: 1, y: 2 } } },
        ],
      },
      { text: "Готово, сэр." },
      { text: "Готово, сэр." },
    ]);
    await handleUserText(session({ hasSelection: false, clickFail: true }), "запомни и нажми кнопку", deps(llm2, false, tasks2));
    expect(tasks2.toJSON().tasks[0]?.state).toBe("failed"); // мутацию ПРОБОВАЛИ и не сделали — строгость на месте
  });

  it("browser-open-overlay-code: отказ вуали у browser_open — состояние системы, а не провал модели (без эскалации и нуджа)", async () => {
    const open = (id: string) => ({ id, name: "browser_open", input: { url: "https://youtube.com" } });
    const llm = new MockLlmProvider([
      { toolUses: [open("o1")] },
      { toolUses: [open("o2")] },
      { text: "Оверлей ещё открыт, сэр — не могу открыть вкладку, дождусь." },
    ]);
    await handleUserText(session({ hasSelection: true, browserVeil: true }), "открой ютуб", deps(llm, true));
    expect(llm.requests.length).toBe(3); // до фикса: 4-й раунд — нудж анти-капитуляции
    expect(llm.requests.every((r) => r.model !== "f")).toBe(true); // и эскалация «от состояния системы»
    expect(toolResultText(llm.requests[1]!.messages)).toMatch(/вуаль режима выделения/u);
  });

  it("step-failure-journal: ОБЫЧНЫЙ частичный провал берста (без вуали) доходит до журнала как ЧАСТИЧНО, а не «ОШИБКА»", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-c8-cp-"));
    process.env.JARVIS_CONTEXT_SOFT_TOKENS = "20000";
    process.env.JARVIS_CONTEXT_HARD_TOKENS = "30000";
    try {
      const checkpoints = new CheckpointStore(dir);
      const steps = [{ action: "input.type", params: { text: "a" } }, { action: "input.key", params: { combo: "Tab" } }, { action: "input.click", target: { by: "text", text: "OK" } }];
      const llm = new MockLlmProvider([
        { toolUses: [{ id: "b1", name: "input_batch", input: { steps } }] },
        { toolUses: [{ id: "w1", name: "web_search", input: { query: "x" } }], usage: { inputTokens: 50_000 } },
        { text: "не должно вызваться" },
      ]);
      await handleUserText(session({ hasSelection: false, batchFail: true }), "заполни форму и найди рецепт", { ...deps(llm, false), checkpoints });
      const cp = checkpoints.peek("u1");
      expect(cp?.digest).toMatch(/input_batch\([^)]*\) — ЧАСТИЧНО — шаги 1\.\.2 УЖЕ ВЫПОЛНЕНЫ/u); // до фикса: «— ОШИБКА» → повтор набора и кликов
      expect(cp?.digest).not.toMatch(/input_batch\([^)]*\) — ОШИБКА/u);
    } finally {
      delete process.env.JARVIS_CONTEXT_SOFT_TOKENS;
      delete process.env.JARVIS_CONTEXT_HARD_TOKENS;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── контроль-9: частичное исполнение не стирается; «идёт задание» и «отчёт о прошлом» — разные вещи ──
describe("режим выделения в петле — контроль-9", () => {
  const skillsOf9 = (steps: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
    ({
      list: async () => [],
      get: async () => ({ id: "sk1", name: "Процедура", version: 1, steps, needsReview: false }),
      save: async () => null,
      recall: async () => null,
      recordOutcome: async () => undefined,
      ...extra,
    }) as unknown as AgentDeps["skills"];

  it("veil-partial-macro-erased: шаги АВТО-МАКРОСА не стираются отказом берста со stepIndex 0", async () => {
    const tasks = new TaskManager();
    // Навык годится для слепого реплея: ≥2 шага, все REPLAY_SAFE, есть input.*; фраза командная, через wake.
    // Без «сочинил текст → Enter»: такую пару `replayUnsafe` СОЗНАТЕЛЬНО не реплеит (отправка мимо send-гардов).
    const replaySteps = [
      { action: "app.focus", params: { app: "notepad" } },
      { action: "ui.invoke", params: { handle: "1" } },
      { action: "input.key", params: { combo: "Tab" } },
      { action: "input.key", params: { combo: "Down" } },
    ];
    const skills = skillsOf9(replaySteps, {
      recall: async () => ({ id: "sk1", name: "Нажать кнопку отправки", when: "просят нажать кнопку", procedure: "шаги", version: 1, recallSim: 0.97, recallSimRaw: 0.9, steps: replaySteps }),
    });
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "b1", name: "input_batch", input: { steps: [{ action: "input.key", params: { combo: "Enter" } }] } }] },
      { text: "Понял, сэр." },
      { text: "Понял, сэр." },
    ]);
    const sink = { sentence: () => undefined, display: () => undefined, done: () => undefined };
    // Макрос ложится об вуаль на 4-м шаге (3 исполнено), берст следом — на ПЕРВОМ (stepIndex 0).
    await handleUserText(
      session({ hasSelection: true, skillQueue: [{ stepIndex: 3 }, { stepIndex: 0 }] }),
      "нажми кнопку отправки в блокноте", // командный глагол обязателен: гейт авто-реплея иначе блокирует жесты
      { ...deps(llm, true, tasks), skills },
      sink,
      { viaWake: true },
    );
    const t = tasks.toJSON().tasks[0];
    expect(t?.state).toBe("failed");
    // До фикса контроля-9: присваивание суммы по partialBySource обнуляло вклад макроса → «действие не выполнено»
    // про ТРИ уже совершённых необратимых шага, и владелец повторял команду.
    // Контроль-10 (partial-steps-zero-overwrite): нулевая остановка берста больше не перетирает k=3, поэтому
    // причина называет ровно «после 3 выполненных шагов» — без противоречивого «после 0 … (всего 3)».
    expect(t?.lastError ?? "").toMatch(/после 3 выполненных шагов/u);
    expect(t?.lastError ?? "").not.toMatch(/после 0 выполненных шагов/u);
  });

  it("job-veil-done0-not-failure: задание легло об вуаль на первом действии (done=0) — ход не «done»", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "c1", name: "code_run", input: { lang: "python", code: "import jarvis", background: true } }] },
      { toolUses: [{ id: "j1", name: "job_status", input: { jobId: "job-1" } }] },
      { text: "Скрипт остановился: открыт режим выделения — повторю, когда закроете рамку." },
      { text: "Скрипт остановился: открыт режим выделения — повторю, когда закроете рамку." },
    ]);
    await handleUserText(session({ hasSelection: true, jobVeilDone0: true }), "кликни вот тут скриптом в фоне", deps(llm, true, tasks));
    // До фикса: ни stepIndex, ни injected → признака нет, содержательный финал → done с ok:true и успехом навыку.
    expect(tasks.toJSON().tasks[0]?.state).toBe("failed");
    expect(tasks.toJSON().tasks[0]?.lastError ?? "").toMatch(/вуаль режима выделения/u);
  });

  it("job-status-past-stop-fails-turn: отчёт о ПРОШЛОЙ остановке (задание запущено не в этом ходе) не проваливает верный ответ", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "j1", name: "job_status", input: { jobId: "job-1" } }] },
      { text: "Задание остановилось из-за режима выделения, сэр — успело два действия." },
    ]);
    await handleUserText(session({ hasSelection: false, jobVeil: true }), "что там со скриптом?", deps(llm, false, tasks));
    // До фикса: нейтральный отчёт взводил overlayDeniedAny → failed на ВЕРНЫЙ ответ (гейта разговорного хода у ветки нет).
    expect(tasks.toJSON().tasks[0]?.state).toBe("done");
  });

  it("background-running-gate-whole-round: идущее задание рядом с ПРОВАЛОМ инструмента не глушит анти-капитуляцию", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      {
        toolUses: [
          { id: "j1", name: "job_status", input: { jobId: "job-1" } },
          { id: "k1", name: "input_click", input: { target: { by: "coords", x: 1, y: 2 } } },
        ],
      },
      { text: "Не получается, сэр, я не могу это сделать." },
      { text: "Не получается, сэр, я не могу это сделать." },
    ]);
    await handleUserText(session({ hasSelection: false, jobRunning: true, clickFail: true }), "нажми кнопку и следи за сборкой", deps(llm, false, tasks));
    // До фикса: gateStoppedRound ставился на ЛЮБОЙ running-опрос → нудж анти-капитуляции пропускался,
    // и настоящая капитуляция при реальном провале инструмента проходила молча.
    expect(llm.requests.length).toBeGreaterThanOrEqual(3);
    const nudged = llm.requests.some((r) => JSON.stringify(r.messages).includes("СТОП"));
    expect(nudged).toBe(true);
  });

  it("background-poll-runaway: четыре одинаковых опроса идущего задания — не «топтание» (ни нуджа, ни обрыва)", async () => {
    const tasks = new TaskManager();
    const poll = (id: string) => ({ id, name: "job_status", input: { jobId: "job-1" } });
    const llm = new MockLlmProvider([
      { toolUses: [poll("j1")] },
      { toolUses: [poll("j2")] },
      { toolUses: [poll("j3")] },
      { toolUses: [poll("j4")] },
      { text: "Сборка ещё идёт, сэр — доложу, когда закончится." },
    ]);
    await handleUserText(session({ hasSelection: false, jobRunning: true }), "следи за сборкой и скажи, когда закончится", deps(llm, false, tasks));
    expect(llm.requests.some((r) => JSON.stringify(r.messages).includes("ОДНО И ТО ЖЕ"))).toBe(false);
    expect(tasks.toJSON().tasks[0]?.lastError ?? "").not.toMatch(/повтор одного действия/u); // до фикса: runawayStuck на 4-м
  });

  it("job-kill-neutral-masked-failure: «останови сборку» + дворецкое «Готово» — не «Не вышло»", async () => {
    const tasks = new TaskManager();
    const said: string[] = [];
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "j1", name: "job_status", input: { jobId: "job-1", kill: true } }] },
      { text: "Готово, сэр." },
      { text: "Готово, сэр." },
    ]);
    const sink = { sentence: (x: string) => said.push(x), display: () => undefined, done: () => undefined };
    const reply = await handleUserText(session({ hasSelection: false, jobKilled: true }), "останови сборку", deps(llm, false, tasks), sink);
    expect(tasks.toJSON().tasks[0]?.state).toBe("done"); // до фикса: masked-failure → fail + «Не вышло, сэр»
    expect(`${said.join(" ")} ${reply.voice ?? ""}`).not.toMatch(/Не вышло/u);
  });

  it("veil-denied-sticky: сверенное ушедшее действие НЕ отрицается, но непокрытый отказ вуали оставляет ход провальным", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "e1", name: "skill_execute", input: { skillId: "sk1" } }] }, // действие ушло под вуалью
      { toolUses: [{ id: "k1", name: "input_click", input: { target: { by: "coords", x: 1, y: 2 } } }] }, // отказ вуали, ничего не ушло
      { toolUses: [{ id: "n1", name: "ui_snapshot", input: {} }] }, // вуаль закрыта: чистая сверка
      { text: "Сообщение ушло, сэр — вижу его в ленте." },
    ]);
    await handleUserText(
      session({ hasSelection: true, veilInjected: true, veil: true, snapshotClean: true }),
      "напиши привет вот тут",
      { ...deps(llm, true, tasks), skills: skillsOf9([{ action: "input.type", params: { text: "Привет" } }, { action: "input.key", params: { combo: "Enter" } }]) },
    );
    // 🔴 Контроль-10 (veil-verify-order-rearms-c8): сравнение НОМЕРОВ раундов различало лишь группировку вызовов и
    // откатывало фикс контроля-8 (полое «Готово» после отказанного НОВОГО клика уезжало в done). Ход остаётся
    // ПРОВАЛЬНЫМ — отказанная мутация не состоялась, — но настоящая боль контроля-9 закрыта: про сверенное ушедшее
    // действие больше не говорят «не сделал», названы ОБА факта.
    expect(tasks.toJSON().tasks[0]?.state).toBe("failed");
  });

  it("any-mutate-attempted-ignores-declared-effect: MCP-инструмент, объявленный neutral, не гасит durable-дело", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      {
        toolUses: [
          { id: "t1", name: "mcp__think__sequentialthinking", input: { thought: "подумаю" } },
          { id: "m1", name: "memory_write", input: { content: "Владелец работает по ночам", kind: "fact" } },
        ],
      },
      { text: "Готово, сэр." },
      { text: "Готово, сэр." },
    ]);
    const mcp = {
      connected: true,
      has: (n: string) => n.startsWith("mcp__"),
      callTool: async () => ({ content: "ок", isError: false }),
      declaredEffect: () => "neutral" as const,
      asToolSchemas: () => [{ name: "mcp__think__sequentialthinking", description: "думать", input_schema: { type: "object", properties: {} } }],
    } as unknown as AgentDeps["mcp"];
    await handleUserText(session({ hasSelection: false }), "подумай и запомни, что я работаю по ночам", { ...deps(llm, false, tasks), mcp });
    // До фикса: имя think не проходит READONLY_NAME_RE → toolEffect=mutate → anyMutateAttempted → durableNeutralDone
    // гас, и «Готово» подменялось на «Не вышло» при реально записанном факте.
    expect(tasks.toJSON().tasks[0]?.state).toBe("done");
  });
});

// ── контроль-10: отчёт о ЧУЖОМ/прошлом задании не решает исход хода; ожидание процесса не глушит anti-runaway ──
describe("режим выделения в петле — контроль-10", () => {
  it("veil-verify-order-rearms-c8: полое «Готово» после отказанного НОВОГО клика — провал, а сверенное ушедшее действие названо честно", async () => {
    const tasks = new TaskManager();
    const said: string[] = [];
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "e1", name: "skill_execute", input: { skillId: "sk1" } }] }, // действие ушло под вуалью
      { toolUses: [{ id: "k1", name: "input_click", input: { target: { by: "coords", x: 1, y: 2 } } }] }, // НОВЫЙ клик отвергнут вуалью
      { toolUses: [{ id: "n1", name: "ui_snapshot", input: {} }] }, // сверка СЛЕДУЮЩИМ раундом
      { text: "Готово, сэр." },
      { text: "Готово, сэр." },
    ]);
    const sink = { sentence: (x: string) => said.push(x), display: () => undefined, done: () => undefined };
    const reply = await handleUserText(
      session({ hasSelection: true, veilInjected: true, veil: true, snapshotClean: true }),
      "напиши привет вот тут и нажми кнопку",
      {
        ...deps(llm, true, tasks),
        skills: {
          list: async () => [],
          get: async () => ({ id: "sk1", name: "Написать", version: 1, steps: [{ action: "input.type", params: { text: "Привет" } }, { action: "input.key", params: { combo: "Enter" } }], needsReview: false }),
          save: async () => null,
          recall: async () => null,
          recordOutcome: async () => undefined,
        } as unknown as AgentDeps["skills"],
      },
      sink,
    );
    // Сверка в СЛЕДУЮЩЕМ раунде (а не в одном с отказом) больше не «удостоверяет» отказанную мутацию.
    expect(tasks.toJSON().tasks[0]?.state).toBe("failed");
    const voice = `${said.join(" ")} ${reply.voice ?? ""}`;
    expect(voice).toMatch(/сверил/u); // ушедшее действие не отрицаем
    expect(voice).not.toMatch(/Нужное действие я при этом не сделал/u);
  });

  it("job-report-self-registers-launch: отчёт с УШЕДШИМ действием о задании ПРОШЛОГО хода не проваливает верный ответ", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "j1", name: "job_status", input: { jobId: "job-1" } }] },
      { text: "Задание остановилось из-за рамки, сэр: два действия ушли, исход последнего не подтверждён." },
    ]);
    await handleUserText(session({ hasSelection: false, jobVeilInjected: true }), "что там со скриптом?", deps(llm, false, tasks));
    // До фикса: overlayDeniedResult ставил uncertain → отчёт регистрировал САМ СЕБЯ как запуск этого хода.
    expect(tasks.toJSON().tasks[0]?.state).toBe("done");
  });

  it("background-done-past-turn: «задание завершилось» из ПРОШЛОГО хода не кредитует текущий ход успехом", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      {
        toolUses: [
          { id: "j1", name: "job_status", input: { jobId: "job-1" } },
          { id: "k1", name: "input_click", input: { target: { by: "coords", x: 1, y: 2 } } },
        ],
      },
      { text: "Готово, сэр." },
      { text: "Готово, сэр." },
    ]);
    await handleUserText(session({ hasSelection: false, jobDone: true, clickFail: true }), "проверь сборку и нажми кнопку", deps(llm, false, tasks));
    // До фикса: anyMutateSucceeded взводился идемпотентным отчётом → masked-failure выключен → done с ok:true.
    expect(tasks.toJSON().tasks[0]?.state).toBe("failed");
  });

  it("partial-counters-before-gate: шаги ПРОШЛОГО задания не приписываются текущему ходу", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "j1", name: "job_status", input: { jobId: "job-1" } }] },
      { toolUses: [{ id: "k1", name: "input_click", input: { target: { by: "coords", x: 1, y: 2 } } }] },
      { text: "Не смог, сэр — дождусь закрытия рамки." },
      { text: "Не смог, сэр — дождусь закрытия рамки." },
    ]);
    await handleUserText(session({ hasSelection: true, jobVeil: true, veil: true }), "посмотри статус и нажми кнопку", deps(llm, true, tasks));
    const t = tasks.toJSON().tasks[0];
    expect(t?.state).toBe("failed");
    // До фикса: счётчики наполнялись ДО гейта → «остановлено после 2 выполненных шагов» про чужую работу.
    expect(t?.lastError ?? "").not.toMatch(/2 выполненных шагов/u);
  });

  it("background-wait-round-too-wide: опрос задания рядом с ПОВТОРЯЮЩИМСЯ кликом не выключает anti-runaway", async () => {
    const tasks = new TaskManager();
    const round = (n: number) => ({
      toolUses: [
        { id: `j${n}`, name: "job_status", input: { jobId: "job-1" } },
        { id: `k${n}`, name: "input_click", input: { target: { by: "coords", x: 10, y: 20 } } },
      ],
    });
    const llm = new MockLlmProvider([round(1), round(2), round(3), round(4), { text: "Готово, сэр." }, { text: "Готово, сэр." }]);
    await handleUserText(session({ hasSelection: false, jobRunning: true }), "следи за сборкой и жми кнопку", deps(llm, false, tasks));
    // До фикса: roundErrors===0 делал раунд «ожиданием» → ни нуджа на 3-м, ни обрыва на 4-м.
    expect(llm.requests.some((r) => JSON.stringify(r.messages).includes("ОДНО И ТО ЖЕ"))).toBe(true);
  });
});
