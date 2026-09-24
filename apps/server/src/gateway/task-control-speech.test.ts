/**
 * Ревью 2026-09-24 (B-F2): «стоп/замолчи/хватит» во время и СРАЗУ ПОСЛЕ речи Джарвиса — это «замолчи»,
 * а не задача модели и не медиаклавиша.
 *
 * Корень: владелец перебивает Джарвиса → barge-in обрывает синтез → пайплайн уже в listening, и его «стоп»
 * доезжает из STT через 1–2 с. Прежний гейт смотрел только на state==="speaking": «Джарвис не говорит, задач
 * нет» → «стоп» уходил в роутер (play/pause-ПЕРЕКЛЮЧАТЕЛЬ — мог ЗАПУСТИТЬ музыку), «заткнись» — в модель.
 * Реверт: верни в task-control проверку `ctx.voice.state !== "speaking"` — первые два теста упадут.
 */
import { describe, expect, it, vi } from "vitest";
import { TaskManager } from "../brain/tasks/manager.js";
import type { SessionContext } from "./router-ws.js";
import { handleControlUtterance, jarvisSpeechBusy } from "./task-control.js";

function fakeCtx(voiceOver: Record<string, unknown> = {}) {
  const tasks = new TaskManager();
  const voice = {
    state: "listening",
    onVadEvent: vi.fn(),
    clearPendingSpeech: vi.fn(),
    speakQueued: vi.fn(),
    quiet: vi.fn(),
    speak: vi.fn(),
    ...voiceOver,
  };
  const ctx = {
    session: { sessionId: "s1", userId: "u1", send: vi.fn() },
    voice,
    agentDeps: { tasks },
  } as unknown as SessionContext;
  return { ctx, voice, tasks };
}

describe("B-F2: «стоп» сразу после речи Джарвиса — «замолчи», не медиаклавиша", () => {
  it("barge-in был 1,2 с назад, задач нет, Джарвис уже не «speaking» → «стоп» перехвачен (в роутер не ушёл)", () => {
    const { ctx, voice } = fakeCtx({ msSinceBargeIn: () => 1_200 });
    expect(handleControlUtterance(ctx, "стоп")).toBe(true);
    expect(voice.onVadEvent).toHaveBeenCalledWith("barge_in");
    expect(voice.clearPendingSpeech).toHaveBeenCalled();
  });

  it("клиент ещё ДОИГРЫВАЕТ реплику (синтез кончился раньше звука) → «тише» — это «замолчи», не громкость", () => {
    const { ctx } = fakeCtx({ isClientPlaying: () => true });
    expect(handleControlUtterance(ctx, "тише")).toBe(true);
  });

  it("barge-in давно, клиент молчит, задач нет → «стоп» уходит дальше (команда плееру — прежнее поведение)", () => {
    const { ctx, voice } = fakeCtx({ msSinceBargeIn: () => 5_000, isClientPlaying: () => false });
    expect(handleControlUtterance(ctx, "стоп")).toBe(false);
    expect(voice.onVadEvent).not.toHaveBeenCalled();
  });

  it("jarvisSpeechBusy: speaking / играет / свежий barge — занят; иначе и без датчиков — свободен", () => {
    expect(jarvisSpeechBusy({ state: "speaking" })).toBe(true);
    expect(jarvisSpeechBusy({ state: "idle", isClientPlaying: () => true })).toBe(true);
    expect(jarvisSpeechBusy({ state: "listening", msSinceBargeIn: () => 2_999 })).toBe(true);
    expect(jarvisSpeechBusy({ state: "listening", msSinceBargeIn: () => 3_000 })).toBe(false);
    expect(jarvisSpeechBusy({ state: "listening", msSinceBargeIn: () => Number.POSITIVE_INFINITY })).toBe(false);
    expect(jarvisSpeechBusy({ state: "listening" })).toBe(false);
  });
});

// Контроль-1 №2 (ревью 2026-09-24): «замолчи/хватит» — перестать ГОВОРИТЬ. Первая версия B-F2 делала их рефлексом
// silence/kill: «замолчи» посреди рассказа ОТМЕНЯЛО все задачи и держало напоминания 10 минут, «Хватит!» из фильма
// в окне разговора убивало работу. Реверт: верни слова в SILENCE_WORDS / голое «хватит» в kill — тесты 2 и 3 упадут.
describe("«заткнись/замолчи/хватит» — перестать говорить, задачи живы, в модель не уходит", () => {
  it("«да замолчи ты уже» в тишине без задач → проглочено: ни модели, ни quiet, ни слова в ответ", () => {
    const { ctx, voice } = fakeCtx();
    expect(handleControlUtterance(ctx, "да замолчи ты уже", "voice")).toBe(true);
    expect(voice.quiet).not.toHaveBeenCalled();
    expect(voice.speak).not.toHaveBeenCalled();
  });

  it("«заткнись», пока Джарвис рассказывает о фоновой задаче — речь оборвана, задача ЖИВА, режима тишины нет", () => {
    const { ctx, voice, tasks } = fakeCtx({ state: "speaking" });
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "долгая" });
    expect(handleControlUtterance(ctx, "Джарвис, заткнись", "voice")).toBe(true);
    expect(tasks.get(t.taskId)?.state).not.toBe("cancelled");
    expect(voice.onVadEvent).toHaveBeenCalledWith("barge_in");
    expect(voice.quiet).not.toHaveBeenCalled();
  });

  it("голое «хватит уже» при идущей задаче — задача не отменена, ack «Остановил» не звучит", () => {
    const { ctx, voice, tasks } = fakeCtx();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "что-то делаю" });
    expect(handleControlUtterance(ctx, "хватит уже", "voice")).toBe(true);
    expect(tasks.get(t.taskId)?.state).not.toBe("cancelled");
    expect(voice.quiet).not.toHaveBeenCalled();
    expect(voice.speak).not.toHaveBeenCalled();
  });

  it("«вырубись» — по-прежнему kill: задачи остановлены (рефлекс W0 не тронут)", () => {
    const { ctx, tasks } = fakeCtx();
    const t = tasks.create({ userId: "u1", sessionId: "s1", goal: "что-то делаю" });
    expect(handleControlUtterance(ctx, "вырубись", "voice")).toBe(true);
    expect(tasks.get(t.taskId)?.state).toBe("cancelled");
  });
});
