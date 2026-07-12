import { describe, expect, it } from "vitest";
import { TaskManager } from "./manager.js";

/** Управляемые часы (unix ms) для детерминизма прогресса/sweep/сортировки. */
function clock(start = 1_000) {
  let t = start;
  const now = () => t;
  return {
    now,
    set: (v: number) => {
      t = v;
    },
    advance: (dt: number) => {
      t += dt;
    },
  };
}

describe("TaskManager — жизненный цикл задач (§20)", () => {
  it("create → get: задача в running, прогресс 0, свежий cancel-флаг", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    const task = m.create({ userId: "u1", sessionId: "s1", goal: "таблица", stepsTotal: 40 });

    expect(task.state).toBe("running");
    expect(task.stepsDone).toBe(0);
    expect(task.stepsTotal).toBe(40);
    expect(task.startedAt).toBe(1_000);
    expect(task.cancel).toEqual({ cancelled: false });
    expect(task.finishedAt).toBeUndefined();
    expect(typeof task.taskId).toBe("string");
    expect(task.taskId.length).toBeGreaterThan(0);

    expect(m.get(task.taskId)).toBe(task);
    expect(m.get("нет-такой")).toBeUndefined();
  });

  it("active(): самая свежая нетерминальная задача сессии", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    const first = m.create({ userId: "u1", sessionId: "s1", goal: "a" });
    c.advance(10);
    const second = m.create({ userId: "u1", sessionId: "s1", goal: "b" });
    c.advance(10);
    // задача чужой сессии не должна влиять на active("s1")
    m.create({ userId: "u1", sessionId: "s2", goal: "c" });

    expect(m.active("s1")).toBe(second);

    // завершаем свежую — active откатывается к более ранней живой
    m.finish(second.taskId, "готово");
    expect(m.active("s1")).toBe(first);

    // отменяем последнюю живую — активных в сессии больше нет
    m.cancel(first.taskId);
    expect(m.active("s1")).toBeUndefined();
  });

  it("cancel: выставляет cancel.cancelled, state cancelled, finishedAt; повтор → false", () => {
    const c = clock(5_000);
    const m = new TaskManager(c.now);
    const task = m.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const cancelRef = task.cancel; // ссылка, которую держит петля агента

    c.advance(123);
    expect(m.cancel(task.taskId)).toBe(true);
    expect(task.state).toBe("cancelled");
    expect(task.finishedAt).toBe(5_123);
    // мутирован ТОТ ЖЕ объект cancel-флага, а не заменён новым
    expect(task.cancel).toBe(cancelRef);
    expect(cancelRef.cancelled).toBe(true);

    // повторная отмена терминальной задачи — no-op
    expect(m.cancel(task.taskId)).toBe(false);
    // несуществующая задача
    expect(m.cancel("нет")).toBe(false);
  });

  it("steer: правка кладётся в активную задачу (true); терминальная/несуществующая → false", () => {
    const m = new TaskManager(clock().now);
    const task = m.create({ userId: "u1", sessionId: "s1", goal: "g" });
    const steerRef = task.steer; // ссылка, которую держит петля агента

    expect(m.steer(task.taskId, "нет, не то")).toBe(true);
    expect(m.steer(task.taskId, "добавь ещё график")).toBe(true);
    expect(task.steer).toBe(steerRef); // мутирован ТОТ ЖЕ объект, не заменён
    expect(task.steer.pending).toEqual(["нет, не то", "добавь ещё график"]);

    expect(m.steer(task.taskId, "   ")).toBe(false); // пустая правка игнорируется
    m.cancel(task.taskId);
    expect(m.steer(task.taskId, "поздно")).toBe(false); // терминальную не рулим
    expect(m.steer("нет", "x")).toBe(false); // несуществующая
  });

  it("cancelSession: снимает ВСЕ незавершённые задачи сессии (параллельный режим §20)", () => {
    const c = clock(2_000);
    const m = new TaskManager(c.now);
    const a = m.create({ userId: "u1", sessionId: "s1", goal: "a" });
    const b = m.create({ userId: "u1", sessionId: "s1", goal: "b" });
    const other = m.create({ userId: "u1", sessionId: "s2", goal: "c" }); // чужая сессия
    m.finish(b.taskId); // уже терминальна — cancelSession её не трогает

    c.advance(50);
    const cancelled = m.cancelSession("s1");
    expect(cancelled.map((t) => t.taskId)).toEqual([a.taskId]); // только живая «a» из s1
    expect(a.state).toBe("cancelled");
    expect(a.cancel.cancelled).toBe(true); // тот же флаг, что держит петля
    expect(a.finishedAt).toBe(2_050);
    expect(b.state).toBe("done"); // терминальная не перезаписана
    expect(other.state).toBe("running"); // чужая сессия не тронута

    // Идемпотентность: повторно нечего снимать.
    expect(m.cancelSession("s1")).toEqual([]);
  });

  it("pause/resume: разрешённые переходы и запреты", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    const task = m.create({ userId: "u1", sessionId: "s1", goal: "g" });

    expect(m.pause(task.taskId)).toBe(true);
    expect(task.state).toBe("paused");

    // повторная пауза уже paused — запрещена
    expect(m.pause(task.taskId)).toBe(false);

    expect(m.resume(task.taskId)).toBe(true);
    expect(task.state).toBe("running");

    // resume из running — запрещён
    expect(m.resume(task.taskId)).toBe(false);

    // pause/resume после терминала запрещены
    m.finish(task.taskId);
    expect(m.pause(task.taskId)).toBe(false);
    expect(m.resume(task.taskId)).toBe(false);

    expect(m.pause("нет")).toBe(false);
    expect(m.resume("нет")).toBe(false);
  });

  it("finish/fail: терминальность и идемпотентность", () => {
    const c = clock(2_000);
    const m = new TaskManager(c.now);

    const a = m.create({ userId: "u1", sessionId: "s1", goal: "g" });
    c.advance(50);
    const finished = m.finish(a.taskId, "итог");
    expect(finished).toBe(a);
    expect(a.state).toBe("done");
    expect(a.finishedAt).toBe(2_050);
    expect(a.resultSummary).toBe("итог");
    // повторный finish и fail после терминала — no-op
    expect(m.finish(a.taskId)).toBeUndefined();
    expect(m.fail(a.taskId, "поздно")).toBeUndefined();
    expect(a.state).toBe("done");

    const b = m.create({ userId: "u1", sessionId: "s1", goal: "g2" });
    const failed = m.fail(b.taskId, "сломалось");
    expect(failed).toBe(b);
    expect(b.state).toBe("failed");
    expect(b.lastError).toBe("сломалось");
    expect(m.fail(b.taskId, "ещё")).toBeUndefined();
    expect(b.lastError).toBe("сломалось");

    expect(m.finish("нет")).toBeUndefined();
    expect(m.fail("нет", "e")).toBeUndefined();
  });

  it("progress: обновляет активную задачу и no-op после терминала", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    const task = m.create({ userId: "u1", sessionId: "s1", goal: "g" });

    const p = m.progress(task.taskId, 5, 40);
    expect(p).toBe(task);
    expect(task.stepsDone).toBe(5);
    expect(task.stepsTotal).toBe(40);

    // stepsTotal не передан — остаётся прежним
    m.progress(task.taskId, 6);
    expect(task.stepsDone).toBe(6);
    expect(task.stepsTotal).toBe(40);

    // после завершения прогресс не двигается
    m.finish(task.taskId);
    expect(m.progress(task.taskId, 99)).toBeUndefined();
    expect(task.stepsDone).toBe(6);

    expect(m.progress("нет", 1)).toBeUndefined();
  });

  it("progress: кламп — не >total, не <0, мусор не ломает", () => {
    const m = new TaskManager(clock().now);
    const t = m.create({ userId: "u1", sessionId: "s1", goal: "g", stepsTotal: 10 });
    m.progress(t.taskId, 99);
    expect(t.stepsDone).toBe(10); // не больше total
    m.progress(t.taskId, -5);
    expect(t.stepsDone).toBe(0); // не меньше 0
    m.progress(t.taskId, Number.NaN);
    expect(t.stepsDone).toBe(0); // мусор → держим прежнее
  });

  it("list: задачи пользователя свежими первыми (startedAt desc)", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    c.set(100);
    const t1 = m.create({ userId: "u1", sessionId: "s1", goal: "1" });
    c.set(300);
    const t3 = m.create({ userId: "u1", sessionId: "s1", goal: "3" });
    c.set(200);
    const t2 = m.create({ userId: "u1", sessionId: "s1", goal: "2" });
    // чужой пользователь не попадает в list("u1")
    c.set(400);
    m.create({ userId: "u2", sessionId: "s9", goal: "x" });

    const ids = m.list("u1").map((t) => t.taskId);
    expect(ids).toEqual([t3.taskId, t2.taskId, t1.taskId]);
    expect(m.list("u2")).toHaveLength(1);
    expect(m.list("нет")).toEqual([]);
  });

  it("sweep: удаляет старые терминальные, щадит свежие и активные", () => {
    const c = clock();
    const m = new TaskManager(c.now);

    c.set(0);
    const oldDone = m.create({ userId: "u1", sessionId: "s1", goal: "old" });
    m.finish(oldDone.taskId); // finishedAt = 0

    c.set(1_000);
    const recentDone = m.create({ userId: "u1", sessionId: "s1", goal: "recent" });
    m.finish(recentDone.taskId); // finishedAt = 1_000

    const active = m.create({ userId: "u1", sessionId: "s1", goal: "active" }); // running

    // now=1_400, ttl=500: oldDone (now-0=1_400>500) удаляется,
    // recentDone (now-1_000=400, не >500) и active — щадятся
    const removed = m.sweep(1_400, 500);
    expect(removed).toBe(1);
    expect(m.get(oldDone.taskId)).toBeUndefined();
    expect(m.get(recentDone.taskId)).toBe(recentDone);
    expect(m.get(active.taskId)).toBe(active);

    // дефолтный ttl (10 минут) — свежий терминальный ещё жив
    expect(m.sweep(1_400)).toBe(0);
    expect(m.get(recentDone.taskId)).toBe(recentDone);
  });
});

describe("TaskManager — onChange (персист §5)", () => {
  it("дёргается на КАЖДОЙ мутации жизненного цикла", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    let changes = 0;
    m.setOnChange(() => {
      changes += 1;
    });

    const t = m.create({ userId: "u1", sessionId: "s1", goal: "x" }); // 1
    m.progress(t.taskId, 1); // 2
    m.pause(t.taskId); // 3
    m.resume(t.taskId); // 4
    m.finish(t.taskId, "итог"); // 5
    expect(changes).toBe(5);

    const t2 = m.create({ userId: "u1", sessionId: "s2", goal: "y" }); // 6
    m.cancel(t2.taskId); // 7
    expect(changes).toBe(7);

    const t3 = m.create({ userId: "u1", sessionId: "s3", goal: "z" }); // 8
    m.fail(t3.taskId, "ошибка"); // 9
    expect(changes).toBe(9);
  });

  it("НЕ дёргается на чтениях и на no-op мутациях", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    const t = m.create({ userId: "u1", sessionId: "s1", goal: "x" });
    m.finish(t.taskId, "итог");
    let changes = 0;
    m.setOnChange(() => {
      changes += 1;
    });

    m.get(t.taskId);
    m.list("u1");
    m.active("s1");
    m.recentTerminal("u1");
    m.finish(t.taskId); // уже терминальна → no-op
    m.cancel(t.taskId); // уже терминальна → no-op
    m.pause("нет-такой"); // нет задачи → no-op
    m.sweep(c.now(), 10_000_000); // ничего не удалил → no-op
    expect(changes).toBe(0);
  });

  it("cancelSession дёргает onChange один раз, если что-то снято; иначе — нет", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    m.create({ userId: "u1", sessionId: "s1", goal: "a" });
    m.create({ userId: "u1", sessionId: "s1", goal: "b" });
    let changes = 0;
    m.setOnChange(() => {
      changes += 1;
    });
    expect(m.cancelSession("s1")).toHaveLength(2);
    expect(changes).toBe(1); // одна запись на пакетную отмену, не по задаче
    expect(m.cancelSession("s1")).toHaveLength(0); // уже терминальны
    expect(changes).toBe(1); // нет изменений → нет записи
  });
});

describe("TaskManager — toJSON/restore (переживает рестарт §5)", () => {
  it("toJSON сериализует поля без рантайм-флага cancel", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    const t = m.create({ userId: "u1", sessionId: "s1", goal: "таблица", stepsTotal: 3 });
    m.finish(t.taskId, "готова таблица");

    const json = m.toJSON();
    expect(json.tasks).toHaveLength(1);
    const p = json.tasks[0]!;
    expect(p).not.toHaveProperty("cancel");
    expect(p.taskId).toBe(t.taskId);
    expect(p.state).toBe("done");
    expect(p.resultSummary).toBe("готова таблица");
    // снимок сериализуем как JSON (никаких циклов/функций)
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  it("restore переносит терминальные задачи как есть (память «что сделал»)", () => {
    const c = clock(5_000);
    const src = new TaskManager(c.now);
    const done = src.create({ userId: "u1", sessionId: "s1", goal: "отчёт" });
    src.finish(done.taskId, "отчёт готов");
    const failed = src.create({ userId: "u1", sessionId: "s1", goal: "музыка" });
    src.fail(failed.taskId, "регион заблокирован");
    const cancelled = src.create({ userId: "u1", sessionId: "s1", goal: "загрузка" });
    src.cancel(cancelled.taskId);

    const restored = new TaskManager(() => 9_000);
    restored.restore(src.toJSON(), 9_000);

    expect(restored.get(done.taskId)?.state).toBe("done");
    expect(restored.get(done.taskId)?.resultSummary).toBe("отчёт готов");
    expect(restored.get(failed.taskId)?.state).toBe("failed");
    expect(restored.get(failed.taskId)?.lastError).toBe("регион заблокирован");
    expect(restored.get(cancelled.taskId)?.state).toBe("cancelled");
    // cancel-флаг воссоздан: для отменённой cancelled=true, для done/failed=false
    expect(restored.get(done.taskId)?.cancel).toEqual({ cancelled: false });
    expect(restored.get(cancelled.taskId)?.cancel).toEqual({ cancelled: true });
  });

  it("ЧЕСТНОСТЬ: задача, бывшая НЕ-терминальной, после рестарта помечается failed (не «всё ещё делаю»)", () => {
    const c = clock(5_000);
    const src = new TaskManager(c.now);
    const running = src.create({ userId: "u1", sessionId: "s1", goal: "долгая работа" });
    src.progress(running.taskId, 2, 5); // живая, running
    const paused = src.create({ userId: "u1", sessionId: "s1", goal: "на паузе" });
    src.pause(paused.taskId);

    const restored = new TaskManager(() => 9_000);
    restored.restore(src.toJSON(), 9_000);

    const r = restored.get(running.taskId);
    expect(r?.state).toBe("failed"); // НЕ "running" — петля, что её исполняла, умерла
    expect(r?.lastError).toBe("прервано перезапуском сервера");
    expect(r?.finishedAt).toBe(5_000); // РЕАЛЬНОЕ время жизни (startedAt), не момент рестарта (9_000)
    expect(restored.get(paused.taskId)?.state).toBe("failed");
    // прерванная задача не считается активной — «отмени»/«продолжи» к ней не липнут
    expect(restored.active("s1")).toBeUndefined();
    expect(restored.get(running.taskId)?.cancel).toEqual({ cancelled: true });
  });

  it("restore не дёргает onChange и устойчив к мусору", () => {
    const m = new TaskManager(() => 1_000);
    let changes = 0;
    m.setOnChange(() => {
      changes += 1;
    });
    m.restore(null);
    m.restore(undefined);
    m.restore({});
    m.restore({ tasks: [{ foo: "bar" } as never] }); // без taskId → пропуск
    expect(changes).toBe(0);
    expect(m.list("u1")).toEqual([]);
  });

  it("нечисловые времена в снимке коэрсятся (не «NaN дн назад» в промпте)", () => {
    const m = new TaskManager(() => 9_000);
    m.restore({
      tasks: [
        // валидный taskId, но битые времена (правленный/повреждённый файл)
        { taskId: "x1", userId: "u1", sessionId: "s1", goal: "g", title: "Битая", state: "done", stepsDone: 1, startedAt: "ой" as never, finishedAt: null as never, resultSummary: "ок" },
      ],
    }, 9_000);
    const t = m.get("x1")!;
    expect(Number.isFinite(t.startedAt)).toBe(true);
    expect(t.finishedAt === undefined || Number.isFinite(t.finishedAt)).toBe(true);
    // и формат не выдаёт NaN
    const recent = m.recentTerminal("u1", { now: 9_000 });
    expect(recent.every((x) => Number.isFinite(x.startedAt))).toBe(true);
  });

  it("прерванная задача сохраняет РЕАЛЬНОЕ время, не слипается на момент рестарта", () => {
    const c = clock(1_000);
    const src = new TaskManager(c.now);
    // реальный успех в 1000 + 2 прерванных (running) задачи, начатых раньше
    const realDone = src.create({ userId: "u1", sessionId: "s1", goal: "успех" });
    src.progress(realDone.taskId, 2);
    src.finish(realDone.taskId, "сделано"); // finishedAt=1000
    c.set(1_500);
    const r1 = src.create({ userId: "u1", sessionId: "s1", goal: "долгая1" });
    src.progress(r1.taskId, 1); // running, startedAt=1500
    c.set(1_800);
    const r2 = src.create({ userId: "u1", sessionId: "s1", goal: "долгая2" });
    src.progress(r2.taskId, 1); // running, startedAt=1800

    const restored = new TaskManager(() => 100_000); // рестарт сильно позже
    restored.restore(src.toJSON(), 100_000);
    // прерванные датируются своим startedAt, НЕ «now=100000» → реальный успех не вытеснен
    expect(restored.get(r1.taskId)?.finishedAt).toBe(1_500);
    expect(restored.get(r2.taskId)?.finishedAt).toBe(1_800);
    // в топ-1 по свежести — последняя прерванная (1800), realDone (1000) ниже; но все содержательны и видимы
    const recent = restored.recentTerminal("u1", { now: 100_000 });
    expect(recent.map((t) => t.taskId)).toEqual([r2.taskId, r1.taskId, realDone.taskId]);
  });
});

describe("TaskManager — recentTerminal (осознание «сделал?» §20)", () => {
  function seed(m: TaskManager, c: ReturnType<typeof clock>) {
    c.set(1_000);
    const a = m.create({ userId: "u1", sessionId: "s1", goal: "A" });
    m.progress(a.taskId, 1); // содержательная (был tool-use)
    m.finish(a.taskId, "A готово");
    c.set(2_000);
    const b = m.create({ userId: "u1", sessionId: "s1", goal: "B" });
    m.progress(b.taskId, 2);
    m.fail(b.taskId, "B сломалось");
    c.set(3_000);
    const running = m.create({ userId: "u1", sessionId: "s1", goal: "C" }); // активна
    const other = m.create({ userId: "u2", sessionId: "s9", goal: "D" }); // чужой
    m.progress(other.taskId, 1);
    m.finish(other.taskId, "D");
    return { a, b, running, other };
  }

  it("возвращает только терминальные задачи пользователя, свежие первыми", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    const { a, b, running } = seed(m, c);
    const recent = m.recentTerminal("u1", { now: 3_000 });
    expect(recent.map((t) => t.taskId)).toEqual([b.taskId, a.taskId]); // B (2000) перед A (1000)
    expect(recent.some((t) => t.taskId === running.taskId)).toBe(false); // активная не входит
  });

  it("activeForUser: задачи В РАБОТЕ (не терминальные) пользователя, кроме текущего хода", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    const { a, running } = seed(m, c); // a — done; running — активна; other — чужой done
    const active = m.activeForUser("u1");
    expect(active.map((t) => t.taskId)).toEqual([running.taskId]); // только активная u1
    expect(active.some((t) => t.taskId === a.taskId)).toBe(false); // терминальная не входит
    // excludeId (таск текущего хода) — исключается, чтобы не считать сам вопрос «делом в работе»
    expect(m.activeForUser("u1", running.taskId)).toEqual([]);
    expect(m.activeForUser("u2").length).toBe(0); // чужой other уже done
  });

  it("ОТСЕКАЕТ пустую болтовню (stepsDone=0) — в «сделал?» только содержательные задачи", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    c.set(1_000);
    const chat = m.create({ userId: "u1", sessionId: "s1", goal: "привет" });
    m.finish(chat.taskId, "Здравствуйте, сэр"); // 0 шагов с инструментом → не задача
    c.set(2_000);
    const real = m.create({ userId: "u1", sessionId: "s1", goal: "таблица" });
    m.progress(real.taskId, 3);
    m.finish(real.taskId, "Готово");
    expect(m.recentTerminal("u1", { now: 2_000 }).map((t) => t.taskId)).toEqual([real.taskId]);
  });

  it("отсекает по возрасту (maxAgeMs) и ограничивает по limit", () => {
    const c = clock();
    const m = new TaskManager(c.now);
    const { a, b } = seed(m, c);
    // окно 1500мс от now=3000 → видно только B (finishedAt 2000), A (1000) старо
    const windowed = m.recentTerminal("u1", { now: 3_000, maxAgeMs: 1_500 });
    expect(windowed.map((t) => t.taskId)).toEqual([b.taskId]);
    // limit=1 → только свежайшая
    const limited = m.recentTerminal("u1", { now: 3_000, limit: 1 });
    expect(limited.map((t) => t.taskId)).toEqual([b.taskId]);
    expect(m.recentTerminal("u1", { now: 3_000, limit: 0 })).toEqual([]);
    void a;
  });
});

describe("TaskManager — разговорный ход не всплывает как §20-задача (Б6)", () => {
  it("conversational исключён из active/activeForUser/recentTerminal", () => {
    const m = new TaskManager();
    const talk = m.create({ userId: "u1", sessionId: "s1", goal: "да ты молодец", conversational: true });
    const work = m.create({ userId: "u1", sessionId: "s1", goal: "сделай таблицу" });
    // active/activeForUser видят РАБОЧУЮ задачу, но не разговорную.
    expect(m.active("s1")?.taskId).toBe(work.taskId);
    expect(m.activeForUser("u1").map((t) => t.taskId)).toEqual([work.taskId]);
    // Разговорный ход с прогрессом и завершением НЕ попадает в «что делал?».
    m.progress(talk.taskId, 2);
    m.finish(talk.taskId, "Спасибо, сэр.");
    expect(m.recentTerminal("u1").map((t) => t.taskId)).not.toContain(talk.taskId);
  });

  it("обычная задача по-прежнему всплывает (не сломали содержательные)", () => {
    const m = new TaskManager();
    const work = m.create({ userId: "u1", sessionId: "s1", goal: "сделай отчёт" });
    m.progress(work.taskId, 1);
    m.finish(work.taskId, "Готово");
    expect(m.recentTerminal("u1").map((t) => t.taskId)).toContain(work.taskId);
  });

  it("(6-й проход ревью) cancelUser ОТМЕНЯЕТ разговорную задачу (скрыта из active, но отменяема)", () => {
    const m = new TaskManager();
    const talk = m.create({ userId: "u1", sessionId: "s1", goal: "что происходит с выборами", conversational: true });
    // Скрыта из active/activeForUser (Б6), но «отмени» по userId её снимает — иначе долгий research-ход неостановим.
    expect(m.activeForUser("u1")).toHaveLength(0);
    const cancelled = m.cancelUser("u1");
    expect(cancelled.map((t) => t.taskId)).toContain(talk.taskId);
    expect(m.get(talk.taskId)?.cancel.cancelled).toBe(true);
  });
});

describe("TaskManager.cancelOrphanedTasks (Б4 б, ревью #3)", () => {
  it("отменяет активные задачи СТАРЫХ сессий userId; текущую сессию, терминальные и чужих не трогает", () => {
    const m = new TaskManager();
    const orphan = m.create({ userId: "u1", sessionId: "old", goal: "осиротевшая" });
    const current = m.create({ userId: "u1", sessionId: "new", goal: "на живой сессии" });
    const done = m.create({ userId: "u1", sessionId: "old", goal: "готовая" });
    m.finish(done.taskId, "Готово");
    const other = m.create({ userId: "u2", sessionId: "old", goal: "чужая" });

    const cancelled = m.cancelOrphanedTasks("u1", "new");
    expect(cancelled.map((t) => t.taskId)).toEqual([orphan.taskId]);
    // Петля осиротевшей задачи увидит cancel по общему объекту и завершится честно.
    expect(m.get(orphan.taskId)?.cancel.cancelled).toBe(true);
    expect(m.get(orphan.taskId)?.state).toBe("cancelled");
    expect(m.get(current.taskId)?.state).toBe("running"); // задача живой сессии цела
    expect(m.get(done.taskId)?.state).toBe("done"); // терминальная не тронута
    expect(m.get(other.taskId)?.state).toBe("running"); // чужой userId не тронут
  });

  it("нет осиротевших → пустой результат (не шумим)", () => {
    const m = new TaskManager();
    m.create({ userId: "u1", sessionId: "new", goal: "на живой" });
    expect(m.cancelOrphanedTasks("u1", "new")).toHaveLength(0);
  });

  it("(4-й проход #2) ЖИВУЮ параллельную сессию НЕ трогаем (liveness-предикат)", () => {
    const m = new TaskManager();
    const onLive = m.create({ userId: "u1", sessionId: "live-parallel", goal: "работа живого клиента" });
    const onDead = m.create({ userId: "u1", sessionId: "dead-old", goal: "на мёртвой сессии" });
    // live-parallel жива (текст-драйвер рядом с Electron), dead-old — мёртвый сокет.
    const isAlive = (sid: string) => sid === "live-parallel";
    const cancelled = m.cancelOrphanedTasks("u1", "new", isAlive);
    expect(cancelled.map((t) => t.taskId)).toEqual([onDead.taskId]); // только мёртвая
    expect(m.get(onLive.taskId)?.state).toBe("running"); // работа живого клиента цела
    expect(m.get(onDead.taskId)?.state).toBe("cancelled");
  });
});
