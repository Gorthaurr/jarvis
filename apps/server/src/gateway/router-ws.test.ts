/**
 * Управление задачами через router (§20): голосовые/UI-команды «стоп»/«отмени»/
 * «пауза»/«продолжи»/«что делаешь». Проверяем ключевое различие §20 (stop_tts vs
 * cancel) и маршрутизацию task.control из UI. SessionContext подменяется минимальным
 * фейком — нужны только session.send, voice.onVadEvent и общий TaskManager.
 */
import { describe, expect, it, vi } from "vitest";
import { TaskManager } from "../brain/tasks/manager.js";
import { type SessionContext } from "./router-ws.js";
import { handleControlUtterance, handleTakeover, handleTaskControl } from "./task-control.js";

interface SentEnvelope {
  type: string;
  payload: Record<string, unknown>;
}

function fakeCtx(tasks: TaskManager) {
  const sent: SentEnvelope[] = [];
  const send = vi.fn((type: string, payload: unknown) => {
    sent.push({ type, payload: payload as Record<string, unknown> });
  });
  const onVadEvent = vi.fn();
  const speakQueued = vi.fn();
  const ctx = {
    session: { sessionId: "s1", userId: "u1", send },
    voice: { onVadEvent, clearPendingSpeech: vi.fn(), speakQueued, quiet: vi.fn(), speak: vi.fn() },
    agentDeps: { tasks },
  } as unknown as SessionContext;
  return { ctx, sent, onVadEvent, speakQueued };
}

describe("router task control (§20)", () => {
  it("«стоп» рубит ТОЛЬКО озвучку (barge_in), задачу не трогает", () => {
    const tasks = new TaskManager();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const { ctx, onVadEvent } = fakeCtx(tasks);

    expect(handleControlUtterance(ctx, "стоп")).toBe(true);
    expect(onVadEvent).toHaveBeenCalledWith("barge_in");
    expect(tasks.get(t.taskId)?.state).toBe("running"); // §20: задача жива
  });

  it("🔴 «отмени выделение» при АКТИВНОЙ задаче не прерывает задачу — это команда снять рамку", () => {
    // Слово «отмени» — cancel-слово §20: без узкого перехвата команда режима выделения оборвала бы
    // идущую работу (владелец просил снять рамку, а Джарвис бросил задачу).
    const tasks = new TaskManager();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "собрать отчёт" });
    const { ctx } = fakeCtx(tasks);

    expect(handleControlUtterance(ctx, "отмени выделение")).toBe(false); // не съедено — уйдёт в tier0
    expect(tasks.get(t.taskId)?.state).toBe("running");
    // Контроль: обычное «отмени» задачу по-прежнему снимает.
    expect(handleControlUtterance(ctx, "отмени")).toBe(true);
  });

  it("🔴 «тише» в тишине НЕ съедается перехватом stop_tts — уходит в роутер как команда громкости", () => {
    // Живой прогон 2026-09-02: Джарвис молчит, задач нет, человек говорит «тише» (о музыке) — и НЕ
    // происходит ничего: ни действия, ни ответа. Перехват «замолчи» съедал реплику, хотя обрывать нечего.
    // Реверт: убери гейт «есть что обрывать» в task-control.ts — тест упадёт.
    const tasks = new TaskManager();
    const { ctx, onVadEvent } = fakeCtx(tasks);
    for (const phrase of ["тише", "сделай тише"]) {
      expect(handleControlUtterance(ctx, phrase), phrase).toBe(false);
    }
    expect(onVadEvent).not.toHaveBeenCalled();

    // Во время РЕЧИ то же слово означает «замолчи» — перехват обязан работать как раньше.
    const speaking = fakeCtx(tasks);
    (speaking.ctx as unknown as { voice: { state: string } }).voice.state = "speaking";
    expect(handleControlUtterance(speaking.ctx, "тише")).toBe(true);
    expect(speaking.onVadEvent).toHaveBeenCalledWith("barge_in");

    // И при активной задаче — тоже (её итог сейчас озвучивается).
    const busy = fakeCtx(tasks);
    tasks.create({ userId: "u1", sessionId: "s1", goal: "долгая" });
    expect(handleControlUtterance(busy.ctx, "тише")).toBe(true);
  });

  it("«отмени» отменяет активную задачу (§20)", () => {
    const tasks = new TaskManager();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const { ctx, sent } = fakeCtx(tasks);

    expect(handleControlUtterance(ctx, "отмени")).toBe(true);
    expect(tasks.get(t.taskId)?.state).toBe("cancelled");
    expect(sent.some((e) => e.type === "task.status" && e.payload.state === "cancelled")).toBe(true);
  });

  it("«отмени» снимает ВСЕ параллельные задачи сессии (§20), не только свежую", () => {
    const tasks = new TaskManager();
    const a = tasks.create({ userId: "u1", sessionId: "s1", goal: "первая" });
    const b = tasks.create({ userId: "u1", sessionId: "s1", goal: "вторая" });
    const { ctx, sent } = fakeCtx(tasks);

    expect(handleControlUtterance(ctx, "отмени")).toBe(true);
    expect(tasks.get(a.taskId)?.state).toBe("cancelled"); // старая тоже снята
    expect(tasks.get(b.taskId)?.state).toBe("cancelled");
    // Статус по каждой снятой задаче ушёл в UI.
    const cancelledStatuses = sent.filter((e) => e.type === "task.status" && e.payload.state === "cancelled");
    expect(cancelledStatuses).toHaveLength(2);
  });

  it("«что делаешь» при активной задаче → отчёт статуса (перехвачено)", () => {
    const tasks = new TaskManager();
    tasks.create({ userId: "u1", sessionId: "s1", goal: "таблица расходов" });
    const { ctx, sent } = fakeCtx(tasks);

    expect(handleControlUtterance(ctx, "что делаешь")).toBe(true);
    const transcript = sent.find((e) => e.type === "transcript");
    expect(String(transcript?.payload.text)).toContain("таблица расходов");
  });

  it("«что делаешь» без активной задачи уходит в агент (не перехвачено)", () => {
    const { ctx } = fakeCtx(new TaskManager());
    expect(handleControlUtterance(ctx, "что делаешь")).toBe(false);
  });

  // Интеграционное ревью #6 (РЕГРЕССИЯ): «отмени напоминание/подписку» БЕЗ активной §20-задачи не должно
  // съедаться «Нет активной задачи» — уходит в агент (cancel_reminder и пр.). Перехват cancel — только
  // если реально есть что останавливать.
  it("(#6) «отмени напоминание» без активной задачи уходит в АГЕНТ (не съедается)", () => {
    const { ctx } = fakeCtx(new TaskManager());
    expect(handleControlUtterance(ctx, "отмени напоминание про хлеб")).toBe(false);
  });

  it("(#6) «отмени» СНИМАЕТ скрытую разговорную задачу (перехват, если есть что отменять)", () => {
    const tasks = new TaskManager();
    const talk = tasks.create({ userId: "u1", sessionId: "s1", goal: "что происходит", conversational: true });
    const { ctx } = fakeCtx(tasks);
    expect(handleControlUtterance(ctx, "отмени")).toBe(true); // есть скрытая задача → перехват
    expect(tasks.get(talk.taskId)?.state).toBe("cancelled");
  });

  it("обычная реплика не перехватывается управлением", () => {
    const tasks = new TaskManager();
    tasks.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const { ctx } = fakeCtx(tasks);
    expect(handleControlUtterance(ctx, "открой блокнот")).toBe(false);
  });

  it("task.control(cancel) из UI отменяет задачу по taskId и стримит статус", () => {
    const tasks = new TaskManager();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const { ctx, sent } = fakeCtx(tasks);

    handleTaskControl(ctx, "cancel", t.taskId);
    expect(tasks.get(t.taskId)?.state).toBe("cancelled");
    expect(sent.some((e) => e.type === "task.status" && e.payload.state === "cancelled")).toBe(true);
  });

  it("M7: голосовой cancel ОЗВУЧИВАЕТСЯ; UI/текст — видимый ack (transcript+chat) БЕЗ голоса (§22 text-silent)", () => {
    // Голосовой путь: ack звучит (живой баг тишины после «прекрати…» 2026-07-03 — не регрессируем).
    const tasksV = new TaskManager();
    tasksV.create({ userId: "u1", sessionId: "s1", goal: "gV" });
    const voice = fakeCtx(tasksV);
    expect(handleControlUtterance(voice.ctx, "отмени")).toBe(true); // default source = voice
    expect(voice.speakQueued).toHaveBeenCalledTimes(1);
    expect(String(voice.speakQueued.mock.calls[0]?.[0])).toContain("Остановил");

    // UI-кнопка на карточке: НЕ озвучиваем (панель видит статус), но ack виден в transcript+chat.
    const tasksU = new TaskManager();
    const tU = tasksU.create({ userId: "u1", sessionId: "s1", goal: "gU" });
    const ui = fakeCtx(tasksU);
    handleTaskControl(ui.ctx, "cancel", tU.taskId, "ui");
    expect(ui.speakQueued).not.toHaveBeenCalled(); // §22: UI-канал молчит голосом
    expect(ui.sent.some((e) => e.type === "transcript" && String(e.payload.text).includes("Остановил"))).toBe(true);
    expect(ui.sent.some((e) => e.type === "chat" && String(e.payload.text).includes("Остановил"))).toBe(true);

    // Текст-канал (dev.text / вкладка «Чат»): тоже НЕ звучит, ack в transcript+chat.
    const tasksT = new TaskManager();
    tasksT.create({ userId: "u1", sessionId: "s1", goal: "gT" });
    const text = fakeCtx(tasksT);
    expect(handleControlUtterance(text.ctx, "отмени", "text")).toBe(true);
    expect(text.speakQueued).not.toHaveBeenCalled(); // §22: текст-канал молчит голосом
    expect(text.sent.some((e) => e.type === "chat" && String(e.payload.text).includes("Остановил"))).toBe(true);
  });

  it("статус: голосовое «что делаешь» озвучивается, UI/текст-статус — только текстом (панель и так видит)", () => {
    const tasks = new TaskManager();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "таблица расходов" });
    const voicePath = fakeCtx(tasks);
    expect(handleControlUtterance(voicePath.ctx, "что делаешь")).toBe(true);
    expect(voicePath.speakQueued).toHaveBeenCalledTimes(1);
    expect(String(voicePath.speakQueued.mock.calls[0]?.[0])).toContain("таблица расходов");

    const uiPath = fakeCtx(tasks);
    handleTaskControl(uiPath.ctx, "status", t.taskId, "ui");
    expect(uiPath.speakQueued).not.toHaveBeenCalled();
    expect(uiPath.sent.some((e) => e.type === "transcript")).toBe(true);
  });

  it("pause/resume из UI меняют состояние задачи (§20)", () => {
    const tasks = new TaskManager();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const { ctx } = fakeCtx(tasks);

    handleTaskControl(ctx, "pause", t.taskId);
    expect(tasks.get(t.taskId)?.state).toBe("paused");
    handleTaskControl(ctx, "resume", t.taskId);
    expect(tasks.get(t.taskId)?.state).toBe("running");
  });

  it("task.control без активной задачи — мягкий ответ, без падения", () => {
    const { ctx, sent } = fakeCtx(new TaskManager());
    handleTaskControl(ctx, "cancel");
    expect(sent.some((e) => e.type === "transcript")).toBe(true);
  });

  it("user-takeover НЕ паузит задачу (автономный Джарвис; остановка — только явная, голосом)", () => {
    const tasks = new TaskManager();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const { ctx } = fakeCtx(tasks);

    handleTakeover(ctx, true); // пользователь шевельнул мышью / печатает рядом
    expect(tasks.get(t.taskId)?.state).toBe("running"); // работа НЕ тормозится (no-op)
    handleTakeover(ctx, false);
    expect(tasks.get(t.taskId)?.state).toBe("running");
  });

  it("user-takeover без активной задачи — без падения", () => {
    const { ctx } = fakeCtx(new TaskManager());
    expect(() => handleTakeover(ctx, true)).not.toThrow();
  });
});

// ─── Волна E: killswitch автономии («полный стоп» / «включи автономию») ────────────────────────────
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutonomyFreeze, setAutonomyFreezeForTests } from "../autonomy/freeze.js";

describe("killswitch автономии (волна E)", () => {
  function freshFreeze(): AutonomyFreeze {
    const f = new AutonomyFreeze(mkdtempSync(join(tmpdir(), "jarvis-ks-")));
    setAutonomyFreezeForTests(f);
    return f;
  }

  it("«полный стоп» отменяет задачи, ставит durable-латч и честно называет команду возврата", () => {
    const tasks = new TaskManager();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "долгая работа" });
    const { ctx, sent } = fakeCtx(tasks);
    const freeze = freshFreeze();

    expect(handleControlUtterance(ctx, "Джарвис, полный стоп")).toBe(true);
    expect(freeze.isFrozen()).toBe(true);
    expect(tasks.get(t.taskId)?.state).toBe("cancelled");
    const ack = sent.find((s) => s.type === "transcript")?.payload.text as string;
    expect(ack).toContain("включи автономию"); // обещаем РОВНО ту команду, которую матчер принимает
    expect(ack.toLowerCase()).toContain("напоминания"); // честно: напоминания НЕ глушатся
    setAutonomyFreezeForTests(undefined);
  });

  it("«включи автономию» снимает латч, ПИНАЕТ watch-тик (иначе «продолжится само» — без механизма) и идемпотентна", () => {
    const tasks = new TaskManager();
    const { ctx } = fakeCtx(tasks);
    const tickNow = vi.fn();
    (ctx.agentDeps as unknown as { watch: { tickNow: () => void } }).watch = { tickNow };
    const freeze = freshFreeze();
    freeze.freeze("тест");

    expect(handleControlUtterance(ctx, "включи автономию")).toBe(true);
    expect(freeze.isFrozen()).toBe(false);
    expect(tickNow).toHaveBeenCalled(); // контроль-ревью: без пинка созревшие проверки ждали бы 30с-переопрос
    expect(handleControlUtterance(ctx, "включи автономию")).toBe(true); // идемпотентно, без падения
    setAutonomyFreezeForTests(undefined);
  });

  it("обычные «стоп»/«отмени»/контент killswitch НЕ трогают", () => {
    const tasks = new TaskManager();
    tasks.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const { ctx } = fakeCtx(tasks);
    const freeze = freshFreeze();

    handleControlUtterance(ctx, "стоп");
    handleControlUtterance(ctx, "отмени");
    expect(handleControlUtterance(ctx, "останови музыку")).toBe(false);
    expect(freeze.isFrozen()).toBe(false);
    setAutonomyFreezeForTests(undefined);
  });
});

describe("W0 рефлекс «вырубись»/«тишина» (2026-09-09)", () => {
  function voiceOf(ctx: SessionContext) {
    return (ctx as unknown as { voice: { quiet: ReturnType<typeof vi.fn>; speak: ReturnType<typeof vi.fn>; clearPendingSpeech: ReturnType<typeof vi.fn> } }).voice;
  }

  it("«Джарвис, вырубись» при активной задаче: всё отменено, синтез оборван, проактив придержан, ack ОДНИМ словом мимо очереди", () => {
    // Лог 2026-09-03 21:53: та же реплика уходила в модель как задача и полторы минуты «закрывала окна».
    // Реверт: убери kill-ветку в task-control.ts — тест упадёт (реплика уйдёт в агент).
    const tasks = new TaskManager();
    const a = tasks.create({ userId: "u1", sessionId: "s1", goal: "первая" });
    const b = tasks.create({ userId: "u1", sessionId: "s1", goal: "вторая" });
    const { ctx, sent, onVadEvent, speakQueued } = fakeCtx(tasks);
    expect(handleControlUtterance(ctx, "вырубись,.", "voice")).toBe(true);
    expect(tasks.get(a.taskId)?.state).toBe("cancelled");
    expect(tasks.get(b.taskId)?.state).toBe("cancelled");
    expect(onVadEvent).toHaveBeenCalledWith("barge_in");
    const voice = voiceOf(ctx);
    expect(voice.clearPendingSpeech).toHaveBeenCalled();
    expect(voice.quiet).toHaveBeenCalledWith(60_000);
    expect(voice.speak).toHaveBeenCalledTimes(1);
    expect(String(voice.speak.mock.calls[0]?.[0])).toContain("Остановил");
    expect(speakQueued).not.toHaveBeenCalled(); // мимо очереди — она придержана quiet()
    expect(sent.filter((e) => e.type === "task.status" && e.payload.state === "cancelled")).toHaveLength(2);
  });

  it("«выключись» БЕЗ активных задач всё равно перехватывается (в модель не уходит) и отвечает «Молчу»", () => {
    const tasks = new TaskManager();
    const { ctx } = fakeCtx(tasks);
    expect(handleControlUtterance(ctx, "выключись", "voice")).toBe(true);
    expect(String(voiceOf(ctx).speak.mock.calls[0]?.[0])).toContain("Молчу");
  });

  it("«тишина» — молча: quiet на 10 минут, ни одного слова в ответ", () => {
    const tasks = new TaskManager();
    tasks.create({ userId: "u1", sessionId: "s1", goal: "долгая" });
    const { ctx, speakQueued } = fakeCtx(tasks);
    expect(handleControlUtterance(ctx, "тишина", "voice")).toBe(true);
    const voice = voiceOf(ctx);
    expect(voice.quiet).toHaveBeenCalledWith(10 * 60_000);
    expect(voice.speak).not.toHaveBeenCalled();
    expect(speakQueued).not.toHaveBeenCalled();
  });

  it("«выруби музыку» — НЕ рефлекс: уходит дальше как команда программе", () => {
    const tasks = new TaskManager();
    const { ctx } = fakeCtx(tasks);
    expect(handleControlUtterance(ctx, "выруби музыку", "voice")).toBe(false);
    expect(voiceOf(ctx).quiet).not.toHaveBeenCalled();
  });

  it("из текст-канала ack идёт в чат, а не голосом (§22 text-silent)", () => {
    const tasks = new TaskManager();
    tasks.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const { ctx, sent } = fakeCtx(tasks);
    expect(handleControlUtterance(ctx, "вырубись", "text")).toBe(true);
    expect(voiceOf(ctx).speak).not.toHaveBeenCalled();
    expect(sent.some((e) => e.type === "chat" && String(e.payload.text).includes("Остановил"))).toBe(true);
  });
});
