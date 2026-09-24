/**
 * КЛИЕНТСКАЯ ЧЕСТНОСТЬ: «не смог проверить» ≠ «не получилось» ≠ «ok».
 *
 * Какой живой дефект охраняет тест (два родственных класса, оба стоили владельцу реальных провалов):
 *
 *  (1) ЛОЖНЫЙ УСПЕХ ДИСПЕТЧЕРА. `dispatch()` обязан превращать провал актуатора в честную ошибку
 *      ActionResult{ok:false}. Классы, зафиксированные в карте проекта: «focused:false → модель врёт
 *      „переключил“ на несуществующее окно», «closed:0 → врёт „закрыл“», «code.run с exitCode≠0 отдавал
 *      ok, а stderr прятался в JSON» (ревью C1), «исключение актуатора утекло наружу как успех». Каждый
 *      случай — нарушение закона проекта «инструмент НИКОГДА не возвращает ложный успех».
 *
 *  (2) СЕНСОР, КОТОРЫЙ НЕ СМОГ ОТВЕТИТЬ, ВЫДАЁТСЯ ЗА ДОСТОВЕРНОЕ «условие не выполнено».
 *      `waitFor` (sensors-cheap) при лежащем сайдкаре / сбое RPC / зависшем опросе обязан вернуть
 *      met:false ПЛЮС `unknown:true` — это НЕЗНАНИЕ. Серверный watch по этому флагу не считает
 *      состояние «отлипшим»: без него один моргнувший тик посреди удерживающегося met сбрасывал
 *      metStreak и повторно запускал side-effect («второе письмо человеку»). Симметрично: достоверный
 *      отрицательный ответ (окна реально нет, элемент реально не найден) `unknown` НЕ ставит — иначе
 *      флаг обесценивается и наблюдение перестаёт когда-либо срабатывать.
 *
 * Почему юнит-тесты этого не ловили: покрыты ЧИСТЫЕ куски (race-cap, self-guard, user-presence,
 * windows), а сама ПРОВОДКА — `dispatch()` (switch + гейты честности + catch-all) и цикл `waitFor`
 * (checkOnce → checkOnceCapped → сборка WaitOutcome) — не имела НИ ОДНОГО теста. Точечно снять гейт
 * `if (!out.focused)` или потерять четвёртый элемент CheckTuple можно было, оставив прогон зелёным.
 *
 * Тесты идут через РЕАЛЬНЫЙ `dispatch()` и РЕАЛЬНЫЙ `waitFor()` — мокаются только листья (нативный
 * ввод/сайдкар/захват экрана/Electron), т.е. проверяется наблюдаемый ActionResult, а не текст исходника.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Управляемое состояние листьев (мутируется тестами) ───────────────────────────────────────────
const st = vi.hoisted(() => ({
  launch: async (_app: string): Promise<unknown> => ({ launched: true, target: "chrome" }),
  focus: async (_app: string): Promise<{ focused: boolean }> => ({ focused: true }),
  close: async (_app: string, _force: boolean): Promise<{ closed: number }> => ({ closed: 1 }),
  codeRun: async (): Promise<{ exitCode: number; stdout: string; stderr: string }> => ({ exitCode: 0, stdout: "", stderr: "" }),
  jobStatus: async (): Promise<unknown> => ({ jobId: "job-1", lang: "python", cwd: "C:/", running: true, elapsedMs: 5, stdoutTail: "", stderrTail: "", logDir: "x", killed: false }),
  focusWindow: async (_o: unknown): Promise<{ focused: boolean; hwnd: number; title: string }> => ({ focused: true, hwnd: 7, title: "X" }),
  listWindows: async (): Promise<Array<{ title: string; process: string }>> => [],
  ground: async (_q: unknown): Promise<{ handle: number }> => ({ handle: 42 }),
  capture: (): Promise<unknown> => Promise.resolve({ image: "b64", width: 100, height: 100 }),
  view: async (_path: string, _opts: unknown): Promise<unknown> => ({ image: "ZmlsZQ==", mediaType: "image/png", width: 1, height: 1, format: "png", bytes: 4, resized: false }),
  sidecarReady: true,
  sidecarRequest: async (): Promise<unknown> => ({ text: "", lines: [] }),
  // §режим выделения: листья актуатора выделения — проверяем ПРОВОДКУ dispatch (гейт/пометка/роутинг/маппинг ошибки).
  selStart: async (_w: unknown, _o: unknown): Promise<unknown> => ({ started: true, waiting: true }),
  selView: async (_s: unknown): Promise<unknown> => ({ image: "b64", mediaType: "image/png", width: 1, height: 1, selection: null, ageMs: 1 }),
  selClear: (_o: unknown): unknown => ({ cleared: false, drawCancelled: false }),
  invoke: async (): Promise<void> => undefined,
  observe: async (): Promise<unknown> => undefined,
}));

vi.mock("electron", () => ({
  // Пользователь давно не трогал ввод → гейт USER_BUSY в эти сценарии не вмешивается.
  powerMonitor: { getSystemIdleTime: () => 999 },
  app: {
    getPath: () => {
      throw new Error("no userData in test");
    },
  },
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }) },
}));
vi.mock("./apps.js", () => ({
  launchApp: (app: string) => st.launch(app),
  focusApp: (app: string) => st.focus(app),
  closeApp: (app: string, force: boolean) => st.close(app, force),
}));
vi.mock("./code-runner.js", () => ({ run: () => st.codeRun(), jobStatus: () => st.jobStatus() }));
vi.mock("./windows.js", () => ({
  listWindows: () => st.listWindows(),
  focusWindow: (o: unknown) => st.focusWindow(o),
}));
vi.mock("./ground.js", () => ({
  ground: (q: unknown) => st.ground(q),
  invoke: () => st.invoke(),
  uiSnapshot: async () => ({ items: [] }),
  readContext: async () => "",
}));
vi.mock("./screen.js", () => ({
  captureScreen: () => st.capture(),
  getLastCaptureMapping: () => null,
  probeScreen: async () => ({ hash: "0" }),
}));
// §3.9 зрение на файл: лист мокается — проверяем ПРОВОДКУ dispatch (успех отдаёт данные как есть, провал → ошибка).
vi.mock("./file-view.js", () => ({ viewFile: (p: string, o: unknown) => st.view(p, o) }));
vi.mock("./selection.js", () => ({
  selectionStart: (w: unknown, o: unknown) => st.selStart(w, o),
  selectionView: (s: unknown) => st.selView(s),
  selectionClear: (o: unknown) => st.selClear(o),
}));
vi.mock("./sidecar-client.js", () => ({
  sidecar: () => ({ ready: st.sidecarReady, request: () => st.sidecarRequest() }),
}));
// Наблюдение после действия (fused observe) в этих сценариях не участвует — глушим, чтобы не лезло в UIA.
vi.mock("./observe.js", () => ({ observeAfterAction: () => st.observe(), captureUiFingerprint: async () => undefined }));
// messaging тянет @jarvis/userbots (gramjs/vk-io) — тяжёлый импорт, не нужный ни одному сценарию.
vi.mock("./messaging.js", () => ({ sendMessage: async () => ({ messageId: "1" }), configureSenders: () => undefined }));

import type { ActionCommand } from "@jarvis/protocol";
import { dispatch } from "./index.js";
import { DrawingOverlayError } from "./input.js";
import { selectionStore } from "../selection/store.js";
import { type WaitOutcome, waitFor } from "./sensors-cheap.js";

beforeEach(() => {
  st.launch = async () => ({ launched: true, target: "chrome" });
  st.focus = async () => ({ focused: true });
  st.close = async () => ({ closed: 1 });
  st.codeRun = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  st.jobStatus = async () => ({ jobId: "job-1", lang: "python", cwd: "C:/", running: true, elapsedMs: 5, stdoutTail: "", stderrTail: "", logDir: "x", killed: false });
  st.focusWindow = async () => ({ focused: true, hwnd: 7, title: "X" });
  st.listWindows = async () => [];
  st.ground = async () => ({ handle: 42 });
  st.capture = () => Promise.resolve({ image: "b64", width: 100, height: 100 });
  st.view = async () => ({ image: "ZmlsZQ==", mediaType: "image/png", width: 1, height: 1, format: "png", bytes: 4, resized: false });
  st.sidecarReady = true;
  st.sidecarRequest = async () => ({ text: "", lines: [] });
  st.selStart = async () => ({ started: true, waiting: true });
  st.selView = async () => ({ image: "b64", mediaType: "image/png", width: 1, height: 1, selection: null, ageMs: 1 });
  st.selClear = () => ({ cleared: false, drawCancelled: false });
  st.invoke = async () => undefined;
  st.observe = async () => undefined;
  selectionStore.setDrawing(false);
});

describe("§режим выделения — контроль-4: пометка вуали по окну команды и по наблюдению", () => {
  it("бесшумный ui.invoke под вуалью проходит, но его fused-наблюдение (окно оверлея) помечено overlayDrawing", async () => {
    selectionStore.setDrawing(true);
    st.observe = async () => ({ text: "Jarvis — выделение области\nОбведите область", weak: false, window: "Jarvis — выделение области", changed: false });
    const r = await run({ kind: "ui.invoke", target: { by: "handle", handle: "42" } } as unknown as ActionCommand);
    expect(r.ok).toBe(true);
    expect((r.data as { overlayDrawing?: boolean }).overlayDrawing).toBe(true); // сервер: applyVeil → не сверка
    expect((r.data as { overlayNote?: unknown }).overlayNote).toBeUndefined(); // контроль-6 (V5-5): текст пометки — у сервера, клиент шлёт признак
  });

  it("физическая ступень клика по handle (фолбэк бесшумного) под вуалью — гейт срабатывает ДО сайдкара; без вуали клик уходит в сайдкар", async () => {
    st.invoke = async () => {
      throw new Error("нет InvokePattern");
    };
    const request = vi.fn(async () => ({}));
    st.sidecarRequest = request as unknown as typeof st.sidecarRequest;
    selectionStore.setDrawing(true);
    const denied = await run({ kind: "input.click", target: { by: "handle", handle: "7" } } as unknown as ActionCommand);
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("overlay_drawing");
    expect(request).not.toHaveBeenCalled(); // клик в оверлей с ok = ложный успех, ради которого гейт и ставился
    selectionStore.setDrawing(false);
    const okr = await run({ kind: "input.click", target: { by: "handle", handle: "7" } } as unknown as ActionCommand);
    expect(okr.ok).toBe(true);
    expect(request).toHaveBeenCalled();
  });

  it("вуаль открылась И закрылась ПОКА шёл захват — кадр всё равно помечен (по окну команды, а не по состоянию на возврате)", async () => {
    st.capture = async () => {
      selectionStore.setDrawing(true);
      await new Promise((r) => setTimeout(r, 5)); // захват длится; вуаль закрылась ПОСЛЕ старта команды
      selectionStore.setDrawing(false); // владелец отпустил мышь до возврата захвата
      return { image: "b64", width: 100, height: 100 };
    };
    const r = await run({ kind: "screen.capture" } as ActionCommand);
    expect((r.data as { overlayDrawing?: boolean }).overlayDrawing).toBe(true);
  });

  it("невизуальное wait.for (файл) под вуалью НЕ помечается — «кадр затемнён» про диск была бы ложь; визуальное — помечается и unknown", async () => {
    selectionStore.setDrawing(true);
    const file = await run({ kind: "wait.for", condition: { kind: "file", path: "C:\\__jarvis_nope__\\nope.txt", gone: true }, timeoutMs: 300 } as unknown as ActionCommand);
    expect(file.ok).toBe(true);
    expect((file.data as { met?: boolean; overlayDrawing?: boolean }).met).toBe(true);
    expect((file.data as { overlayDrawing?: boolean }).overlayDrawing).toBeUndefined();
    const txt = await run({ kind: "wait.for", condition: { kind: "text", text: "__none__" }, timeoutMs: 120 } as unknown as ActionCommand);
    expect((txt.data as { overlayDrawing?: boolean; unknown?: boolean }).overlayDrawing).toBe(true);
    expect((txt.data as { unknown?: boolean }).unknown).toBe(true); // ослепшее вуалью ожидание не отвечает «достоверно не наступило»
  });

  it("контроль-6 (C5R-4): ожидание ОКНА (EnumWindows) от вуали не слепнет — под вуалью достоверное met:false БЕЗ пометки и БЕЗ unknown", async () => {
    selectionStore.setDrawing(true);
    st.listWindows = async () => [];
    const win = await run({ kind: "wait.for", condition: { kind: "window", titleContains: "__none__" }, timeoutMs: 120 } as unknown as ActionCommand);
    expect((win.data as { met?: boolean }).met).toBe(false);
    expect((win.data as { overlayDrawing?: boolean }).overlayDrawing).toBeUndefined(); // до фикса: «кадр затемнён» про список окон
    expect((win.data as { unknown?: boolean }).unknown).toBeUndefined();
  });

  it("контроль-6 (C5R-2): вуаль открылась ПОСРЕДИ печати — «ушло, исход не подтверждён» (overlay_drawing + stepActionInjected), а не ok", async () => {
    const request = vi.fn(async () => {
      selectionStore.setDrawing(true); // владелец нажал хоткей, пока сайдкар печатал
      await new Promise((r) => setTimeout(r, 5));
      selectionStore.setDrawing(false);
      return {};
    });
    st.sidecarRequest = request as unknown as typeof st.sidecarRequest;
    const r = await run({ kind: "input.type", text: "Привет, это длинный текст" } as ActionCommand);
    expect(request).toHaveBeenCalled(); // ранний гейт пропустил — вуали на старте не было
    expect(r.ok).toBe(false); // до фикса: ok — остаток нажатий ушёл в окно рисования, а модель слышала «напечатано»
    expect(r.error?.code).toBe("overlay_drawing");
    expect(r.stepActionInjected).toBe(true);
    expect(r.error?.message).toMatch(/УЖЕ УШЛО/u);
    const drag = await run({ kind: "input.mouse", op: "drag", x: 1, y: 1, toX: 50, toY: 50, space: "screen" } as unknown as ActionCommand);
    expect(drag.error?.code).toBe("overlay_drawing");
    expect(drag.stepActionInjected).toBe(true);
  });

  it("контроль-8 (click-role-no-postcheck): вуаль открылась во время ГРУНДИНГА по роли — клик ушёл, исход не подтверждён (не чистый ok)", async () => {
    st.ground = async () => {
      selectionStore.setDrawing(true); // владелец нажал хоткей, пока сайдкар искал элемент (секунды на слепом окне)
      await new Promise((r) => setTimeout(r, 5));
      return { handle: 42 };
    };
    st.sidecarRequest = (async () => ({})) as unknown as typeof st.sidecarRequest;
    const r = await run({ kind: "input.click", target: { by: "role", role: "button", name: "OK" }, method: "physical" } as unknown as ActionCommand);
    expect(r.ok).toBe(false); // до фикса: ok — SendInput ушёл в оверлей, раунд засчитан успешной мутацией
    expect(r.error?.code).toBe("overlay_drawing");
    expect(r.stepActionInjected).toBe(true);
  });

  it("контроль-8 (veiled-during-dead): ВИЗУАЛЬНОЕ ожидание, часть окна которого прошла под вуалью, отвечает НЕЗНАНИЕМ; невизуальное — достоверно", async () => {
    selectionStore.setDrawing(true);
    let polls = 0;
    st.sidecarRequest = (async () => {
      polls += 1;
      if (polls === 1) selectionStore.setDrawing(false);
      return { text: "", lines: [] };
    }) as unknown as typeof st.sidecarRequest;
    const txt = await run({ kind: "wait.for", condition: { kind: "text", text: "__none__" }, timeoutMs: 900, pollMs: 150 } as unknown as ActionCommand);
    const d = txt.data as { met?: boolean; unknown?: boolean; veiled?: boolean; veiledDuring?: unknown };
    expect(d.met).toBe(false);
    expect(d.unknown).toBe(true); // условие могло вспыхнуть и уйти ПОД вуалью — «не смог проверить» ≠ «не наступило»
    expect(d.veiled).toBeUndefined(); // решающие опросы были чистыми — «дождись закрытия оверлея» тут неуместно
    expect(d.veiledDuring).toBeUndefined(); // мёртвое поле контроля-7 убрано, а не оставлено сырым в untrusted
    selectionStore.setDrawing(true);
    const file = await run({ kind: "wait.for", condition: { kind: "file", path: "C:\\__jarvis_nope__\\nope.txt", gone: true }, timeoutMs: 300 } as unknown as ActionCommand);
    expect((file.data as { met?: boolean; unknown?: boolean }).met).toBe(true);
    expect((file.data as { unknown?: boolean }).unknown).toBeUndefined(); // диск вуаль не слепит
  });

  it("контроль-8 (job-status-injected / -caught / done=0): фоновое задание доносит injected, перехват вуали и честный текст", async () => {
    st.jobStatus = async () => ({ jobId: "job-1", lang: "python", cwd: "C:/", running: false, exitCode: 77, elapsedMs: 5, stdoutTail: "typed", stderrTail: "[overlay_drawing] done=2 injected=1 input.type: печать УЖЕ УШЛА", logDir: "x", killed: false });
    const inj = await run({ kind: "job.status", jobId: "job-1" } as ActionCommand);
    expect((inj.data as { overlayInjected?: boolean }).overlayInjected).toBe(true); // до фикса: v.injected выбрасывался
    st.jobStatus = async () => ({ jobId: "job-1", lang: "python", cwd: "C:/", running: false, exitCode: 77, elapsedMs: 5, stdoutTail: "", stderrTail: "[overlay_drawing] done=0 injected=0 input.click: оверлей", logDir: "x", killed: false });
    expect((((await run({ kind: "job.status", jobId: "job-1" } as ActionCommand)).data as { note?: string }).note ?? "")).toMatch(/ДО первого действия/u);
    st.jobStatus = async () => ({ jobId: "job-1", lang: "python", cwd: "C:/", running: false, exitCode: 0, elapsedMs: 5, stdoutTail: "продолжаю", stderrTail: "[overlay_drawing] done=0 injected=0 input.click: оверлей", logDir: "x", killed: false });
    const caught = await run({ kind: "job.status", jobId: "job-1" } as ActionCommand);
    expect((caught.data as { overlayCaught?: boolean }).overlayCaught).toBe(true); // exit 0 + маркер = перехваченный отказ
  });

  it("контроль-6 (C5R-5): ui.snapshot ЯВНО заданного окна (pid) под вуалью НЕ помечается — его дерево не оверлей; без pid — помечается", async () => {
    selectionStore.setDrawing(true);
    const byPid = await run({ kind: "ui.snapshot", pid: 4242 } as unknown as ActionCommand);
    expect(byPid.ok).toBe(true);
    expect((byPid.data as { overlayDrawing?: boolean }).overlayDrawing).toBeUndefined();
    const active = await run({ kind: "ui.snapshot" } as unknown as ActionCommand);
    expect((active.data as { overlayDrawing?: boolean }).overlayDrawing).toBe(true);
  });

  it("контроль-6 (C5R-6): app.launch и window.arrange{maximize} под вуалью отвергаются с суффиксом про клавиатуру окна рисования", async () => {
    selectionStore.setDrawing(true);
    const launch = vi.fn(async () => ({ launched: true, target: "notepad" }));
    st.launch = launch as unknown as typeof st.launch;
    const l = await run({ kind: "app.launch", app: "notepad" } as ActionCommand);
    expect(l.ok).toBe(false);
    expect(l.error?.code).toBe("overlay_drawing");
    expect(l.error?.message).toMatch(/клавиатуру у окна рисования/u);
    expect(launch).not.toHaveBeenCalled();
    const a = await run({ kind: "window.arrange", op: "maximize", hwnd: 7 } as unknown as ActionCommand);
    expect(a.error?.code).toBe("overlay_drawing");
    expect(a.error?.message).toMatch(/клавиатуру у окна рисования/u);
  });

  it("контроль-6 (C5R-7): job.status завершённого python-задания с exit 77 и маркером → overlayStopped + overlayDone, БЕЗ overlayDrawing (не «снято под вуалью»)", async () => {
    st.jobStatus = async () => ({ jobId: "job-1", lang: "python", cwd: "C:/", running: false, exitCode: 77, elapsedMs: 5, stdoutTail: "clicked OK", stderrTail: "Traceback…\n[overlay_drawing] done=2 injected=0 input.click: Поверх экрана открыт оверлей", logDir: "x", killed: false });
    const r = await run({ kind: "job.status", jobId: "job-1" } as ActionCommand);
    expect(r.ok).toBe(true);
    const d = r.data as { overlayStopped?: boolean; overlayDone?: number; overlayReason?: string; overlayDrawing?: boolean; exitCode?: number };
    expect(d.overlayStopped).toBe(true);
    expect(d.overlayDone).toBe(2);
    expect(d.overlayReason).toMatch(/input\.click/u);
    expect(d.overlayDrawing).toBeUndefined();
    expect(d.exitCode).toBe(77);
    st.jobStatus = async () => ({ jobId: "job-1", lang: "python", cwd: "C:/", running: false, exitCode: 1, elapsedMs: 5, stdoutTail: "", stderrTail: "KeyError", logDir: "x", killed: false });
    expect(((await run({ kind: "job.status", jobId: "job-1" } as ActionCommand)).data as { overlayStopped?: boolean }).overlayStopped).toBeUndefined();
  });

  it("контроль-6 (V5-2): code.run с маркером done=2 injected=1 → stepIndex 2, stepActionInjected, хвост stdout в сообщении", async () => {
    st.codeRun = async () => ({ exitCode: 77, stdout: "clicked OK\nclicked Send", stderr: "Traceback…\n[overlay_drawing] done=2 injected=1 input.type: Печать УЖЕ УШЛО в GUI" });
    const r = await run({ kind: "code.run", lang: "python", code: "import jarvis" } as ActionCommand);
    expect(r.error?.code).toBe("overlay_drawing");
    expect(r.stepIndex).toBe(2);
    expect(r.stepActionInjected).toBe(true);
    expect(r.error?.message).toMatch(/Успешно ушедших действий до остановки: 2/u);
    expect(r.error?.message).toMatch(/clicked Send/u);
    st.codeRun = async () => ({ exitCode: 77, stdout: "", stderr: "[overlay_drawing] done=0 injected=0 input.click: оверлей" });
    const zero = await run({ kind: "code.run", lang: "python", code: "import jarvis" } as ActionCommand);
    expect(zero.stepIndex).toBeUndefined();
    expect(zero.stepActionInjected).toBeUndefined();
  });

  it("контроль-6 (C5R-8): skill.execute — вуаль открылась и закрылась ВНУТРИ реплея, наблюдение снято уже с чистого экрана → без пометки; вуаль во время наблюдения → пометка", async () => {
    const request = vi.fn(async () => {
      selectionStore.setDrawing(true);
      await new Promise((r) => setTimeout(r, 5));
      selectionStore.setDrawing(false); // владелец закрыл вуаль ещё до конца шага
      return {};
    });
    st.sidecarRequest = request as unknown as typeof st.sidecarRequest;
    st.observe = async () => ({ text: "Блокнот — Привет", weak: false, window: "Блокнот", changed: true });
    // Контроль-9: шаг НЕинжектирующий (`mode:"up"` в оверлей побочного эффекта не даёт) — у инжектирующего
    // нажатия теперь есть своя пост-проверка, и вуаль внутри его RPC ЧЕСТНО валит шаг (кейс presskey-no-veil-postcheck).
    const clean = await run({ kind: "skill.execute", skillId: "sk", version: 1, steps: [{ action: "input.key", params: { combo: "Shift", mode: "up" } }] } as unknown as ActionCommand);
    expect(clean.ok).toBe(true);
    expect((clean.data as { observation?: unknown }).observation).toBeDefined();
    expect((clean.data as { overlayDrawing?: boolean }).overlayDrawing).toBeUndefined(); // до фикса: окно ВСЕЙ команды → «снято под вуалью», сервер выбрасывал сверку
    st.sidecarRequest = async () => ({});
    st.observe = async () => {
      selectionStore.setDrawing(true);
      await new Promise((r) => setTimeout(r, 5));
      selectionStore.setDrawing(false);
      return { text: "Jarvis — выделение области", weak: false, window: "Jarvis — выделение области", changed: false };
    };
    const veiled = await run({ kind: "skill.execute", skillId: "sk", version: 1, steps: [{ action: "input.key", params: { combo: "Enter" } }] } as unknown as ActionCommand);
    expect(veiled.ok).toBe(true);
    expect((veiled.data as { overlayDrawing?: boolean }).overlayDrawing).toBe(true);
  });

  it("контроль-7 (sensors-8): window.list под вуалью НЕ помечается — EnumWindows тот же источник, что wait_for{window}, и от вуали не слепнет (два вердикта на один источник — дефект)", async () => {
    selectionStore.setDrawing(true);
    st.listWindows = async () => [{ title: "Discord", process: "Discord.exe" }];
    const list = await run({ kind: "window.list" } as ActionCommand);
    expect(list.ok).toBe(true);
    expect((list.data as { overlayDrawing?: boolean }).overlayDrawing).toBeUndefined(); // до фикса: empty:true + «дождись» при валидном списке
    selectionStore.setDrawing(false);
    await new Promise((r) => setTimeout(r, 2));
    expect(((await run({ kind: "window.list" } as ActionCommand)).data as { overlayDrawing?: boolean }).overlayDrawing).toBeUndefined();
  });

  it("контроль-7 (sensors-3/runner-1): browser.open и window.arrange{move} под вуалью отвергаются (окно на передний план отбирает клавиатуру у рисования)", async () => {
    selectionStore.setDrawing(true);
    const launch = vi.fn(async () => ({ launched: true, target: "chrome" }));
    st.launch = launch as unknown as typeof st.launch;
    const b = await run({ kind: "browser.open", url: "https://youtube.com", inDefault: true } as ActionCommand);
    expect(b.ok).toBe(false);
    expect(b.error?.code).toBe("overlay_drawing");
    expect(b.error?.message).toMatch(/клавиатуру у окна рисования/u);
    expect(launch).not.toHaveBeenCalled(); // до фикса: shell-open браузера под вуалью + ok
    const m = await run({ kind: "window.arrange", op: "move", hwnd: 7, monitor: 1 } as unknown as ActionCommand);
    expect(m.error?.code).toBe("overlay_drawing");
  });

  it("контроль-7 (sdk-3): exit 0, но в stderr маркер вуали — скрипт ПЕРЕХВАТИЛ отказ: не чистый ok, а overlayCaught (сервер → uncertain); node — нет", async () => {
    st.codeRun = async () => ({ exitCode: 0, stdout: "не удалось, продолжаю", stderr: "[overlay_drawing] done=0 injected=0 input.click: Поверх экрана открыт оверлей" });
    const r = await run({ kind: "code.run", lang: "python", code: "try:\n  jarvis.click(1,2)\nexcept: pass" } as ActionCommand);
    expect(r.ok).toBe(true);
    expect((r.data as { overlayCaught?: boolean }).overlayCaught).toBe(true); // до фикса: чистый ok → anyMutateSucceeded → «Готово» без единого клика
    expect((r.data as { overlayReason?: string }).overlayReason).toMatch(/input\.click/u);
    const node = await run({ kind: "code.run", lang: "node", code: "x" } as ActionCommand);
    expect((node.data as { overlayCaught?: boolean }).overlayCaught).toBeUndefined();
  });

  it("контроль-7 (sdk-4): в веильном сообщении — настоящий ХВОСТ stdout (stdoutTail), не хвост усечённой головы; усечение объявлено", async () => {
    st.codeRun = async () => ({ exitCode: 77, stdout: "x".repeat(500), stdoutTail: "clicked OK\nclicked Send\nFINAL_LINE", truncated: true, stderr: "[overlay_drawing] done=2 injected=0 input.click: оверлей" }) as never;
    const r = await run({ kind: "code.run", lang: "python", code: "import jarvis" } as ActionCommand);
    expect(r.error?.code).toBe("overlay_drawing");
    expect(r.error?.message).toMatch(/FINAL_LINE/u);
    expect(r.error?.message).toMatch(/усечён/u);
  });

  it("контроль-5 ACT-5: window.focus / app.focus во время рисования гейтятся overlay_drawing — фокус отобрал бы клавиатуру у окна вуали (Esc владельца ушёл бы в чужое окно)", async () => {
    selectionStore.setDrawing(true);
    const focusWindow = vi.fn(async () => ({ focused: true, hwnd: 7, title: "Discord" }));
    st.focusWindow = focusWindow as unknown as typeof st.focusWindow;
    const focusApp = vi.fn(async () => ({ focused: true }));
    st.focus = focusApp as unknown as typeof st.focus;
    const w = await run({ kind: "window.focus", query: "Discord" } as unknown as ActionCommand);
    expect(w.ok).toBe(false);
    expect(w.error?.code).toBe("overlay_drawing");
    expect(w.error?.message).toMatch(/клавиатур/u);
    const a = await run({ kind: "app.focus", app: "discord" } as ActionCommand);
    expect(a.ok).toBe(false);
    expect(a.error?.code).toBe("overlay_drawing");
    expect(focusWindow).not.toHaveBeenCalled();
    expect(focusApp).not.toHaveBeenCalled();
    selectionStore.setDrawing(false);
    await new Promise((r) => setTimeout(r, 2));
    expect((await run({ kind: "window.focus", query: "Discord" } as unknown as ActionCommand)).ok).toBe(true);
  });

  it("контроль-5 ACT-2: input.key{mode:\"up\"} под вуалью ДОХОДИТ до сайдкара (отпустить залипшую клавишу), press — отвергается тем же гейтом", async () => {
    selectionStore.setDrawing(true);
    const request = vi.fn(async () => ({}));
    st.sidecarRequest = request as unknown as typeof st.sidecarRequest;
    const up = await run({ kind: "input.key", combo: "W", mode: "up" } as ActionCommand);
    expect(up.ok).toBe(true);
    expect(request).toHaveBeenCalled();
    const press = await run({ kind: "input.key", combo: "W" } as ActionCommand);
    expect(press.ok).toBe(false);
    expect(press.error?.code).toBe("overlay_drawing");
  });

  it("контроль-5 ACT-1: ожидание пережило вуаль — решающий опрос на ЧИСТОМ экране даёт честное met:true без пометки; ожидание целиком под вуалью — помечено и unknown", async () => {
    selectionStore.setDrawing(true);
    let calls = 0;
    st.listWindows = async () => {
      calls += 1;
      if (calls === 1) {
        selectionStore.setDrawing(false); // владелец закончил обводить посреди ожидания
        return [];
      }
      return [{ title: "Discord", process: "Discord.exe" }];
    };
    const r = await run({ kind: "wait.for", condition: { kind: "window", titleContains: "Discord" }, timeoutMs: 3000 } as unknown as ActionCommand);
    expect(r.ok).toBe(true);
    expect((r.data as { met?: boolean }).met).toBe(true);
    expect((r.data as { overlayDrawing?: boolean }).overlayDrawing).toBeUndefined(); // до фикса: окно всей команды → «снято под вуалью» + unknown
    expect((r.data as { unknown?: boolean }).unknown).toBeUndefined();
  });

  it("контроль-5 ACT-4: код вуали из скрипта — по ВЫДЕЛЕННОМУ exit-коду jarvis.py, а не по маркеру где-то в stderr", async () => {
    st.codeRun = async () => ({ exitCode: 77, stdout: "", stderr: "Traceback (most recent call last):\n  ...\njarvis.JarvisError: [overlay_drawing] input.click: Поверх экрана открыт оверлей режима выделения (уже 3 с)" });
    const r = await run({ kind: "code.run", lang: "python", code: "import jarvis; jarvis.click(1, 2)" } as ActionCommand);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("overlay_drawing");
    expect(r.error?.message).toMatch(/оверлей/u);
    // Перехваченный отказ вуали напечатан в stderr, а упал скрипт ПОЗЖЕ на своей ошибке — это runtime, не вуаль.
    st.codeRun = async () => ({ exitCode: 1, stdout: "", stderr: "[overlay_drawing] input.click: оверлей\nTraceback (most recent call last):\n  ...\nKeyError: 'items'" });
    expect((await run({ kind: "code.run", lang: "python", code: "x" } as ActionCommand)).error?.code).toBe("runtime");
    // Таймаут — не вуаль, даже с «нашим» кодом выхода.
    st.codeRun = async () => ({ exitCode: 77, stdout: "", stderr: "", timedOut: true } as never);
    expect((await run({ kind: "code.run", lang: "python", code: "x" } as ActionCommand)).error?.code).toBe("runtime");
    st.codeRun = async () => ({ exitCode: 1, stdout: "", stderr: "ValueError: boom" });
    expect((await run({ kind: "code.run", lang: "python", code: "x" } as ActionCommand)).error?.code).toBe("runtime");
    // node не видит SDK — его код 77 с похожим текстом не вуаль.
    st.codeRun = async () => ({ exitCode: 77, stdout: "", stderr: "Error: [overlay_drawing] x" });
    expect((await run({ kind: "code.run", lang: "node", code: "x" } as ActionCommand)).error?.code).toBe("runtime");
  });
});

describe("§режим выделения — проводка dispatch() (контроль-3)", () => {
  it("под вуалью явно физический ввод отвергается ЕДИНЫМ кодом overlay_drawing — сервер узнаёт вуаль только по нему", async () => {
    // Раньше ранний гейт отдавал «denied» → сервер считал раунд провалом модели и эскалировал тир.
    selectionStore.setDrawing(true);
    const cmds = [
      { kind: "input.key", combo: "Enter" },
      { kind: "input.type", text: "x" },
      { kind: "input.mouse", op: "move", x: 1, y: 1 },
      { kind: "input.click", target: { by: "coords", x: 1, y: 1 } },
    ] as unknown as ActionCommand[];
    for (const cmd of cmds) {
      const r = await run(cmd);
      expect(r.ok, cmd.kind).toBe(false);
      expect(r.error?.code, cmd.kind).toBe("overlay_drawing");
    }
  });

  it("сенсор под вуалью помечается overlayDrawing (сервер: «снято под вуалью — не сверка»); без вуали пометки нет", async () => {
    selectionStore.setDrawing(true);
    const veiled = await run({ kind: "screen.capture" } as ActionCommand);
    expect(veiled.ok).toBe(true);
    expect((veiled.data as { overlayDrawing?: boolean }).overlayDrawing).toBe(true);
    selectionStore.setDrawing(false);
    const clean = await run({ kind: "screen.capture" } as ActionCommand);
    expect((clean.data as { overlayDrawing?: boolean }).overlayDrawing).toBeUndefined();
  });

  it("screen.selection: view под вуалью (DrawingOverlayError) → overlay_drawing, не runtime; clear с force → рука владельца", async () => {
    st.selView = async () => {
      throw new DrawingOverlayError("Сейчас идёт рисование: на экране вуаль режима выделения");
    };
    const r = await run({ kind: "screen.selection", op: "view" } as ActionCommand);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("overlay_drawing");

    const calls: unknown[] = [];
    st.selClear = (o) => {
      calls.push(o);
      return { cleared: true, drawCancelled: false };
    };
    await run({ kind: "screen.selection", op: "clear", force: true } as ActionCommand);
    await run({ kind: "screen.selection", op: "clear" } as ActionCommand);
    expect(calls).toEqual([{ byOwner: true }, { byOwner: false }]);
  });
});

const run = (cmd: ActionCommand) => dispatch("cmd-1", cmd);

describe("dispatch() — провал актуатора никогда не становится ok (закон честности)", () => {
  it("успешный путь всё-таки ok — тест не проходит «потому что всё всегда ошибка»", async () => {
    const r = await run({ kind: "app.launch", app: "chrome" });
    expect(r.ok).toBe(true);
    expect(r.commandId).toBe("cmd-1");
    expect(typeof r.durationMs).toBe("number");
  });

  it("исключение актуатора → честная error.runtime с текстом причины, а не ok", async () => {
    st.launch = async () => {
      throw new Error("не нашёл исполняемый файл «Дота»");
    };
    const r = await run({ kind: "app.launch", app: "Дота" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("runtime");
    expect(r.error?.message).toContain("не нашёл исполняемый файл");
    expect(r.data).toBeUndefined(); // причина в error, а не спрятана в data под видом успеха
  });

  it("app.focus вернул focused:false → not_found (модель не скажет «переключил»)", async () => {
    st.focus = async () => ({ focused: false });
    const r = await run({ kind: "app.focus", app: "Discord" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("not_found");
    expect(r.error?.message).toMatch(/не сфокусировал/iu);
  });

  it("app.close закрыл 0 процессов → not_found (модель не скажет «закрыл»)", async () => {
    st.close = async () => ({ closed: 0 });
    const r = await run({ kind: "app.close", app: "Notepad" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("not_found");
  });

  it("code.run с ненулевым exitCode → runtime + stderr виден в сообщении (ревью C1)", async () => {
    st.codeRun = async () => ({ exitCode: 1, stdout: "частичный вывод", stderr: "Traceback: ZeroDivisionError" });
    const r = await run({ kind: "code.run", lang: "python", code: "1/0" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("runtime");
    expect(r.error?.message).toContain("ZeroDivisionError");
  });

  it("window.focus: сайдкар бросил И AppActivate не помог → честная ошибка с причиной, не ok", async () => {
    st.focusWindow = async () => {
      throw new Error("сайдкар не запущен");
    };
    st.focus = async () => ({ focused: false }); // фолбэк AppActivate тоже не взял фокус
    const r = await run({ kind: "window.focus", query: "Discord" });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("сайдкар не запущен");
  });

  it("fs.view: успех актуатора → ok, data с картинкой доезжает как есть (проводка §3.9 живая)", async () => {
    st.view = async (p, o) => ({ image: "UE5H", mediaType: "image/jpeg", width: 10, height: 5, format: "jpeg", bytes: 3, resized: false, path: p, opts: o });
    const r = await run({ kind: "fs.view", path: "C:\\tmp\\a.jpg", page: 2, maxSide: 800 });
    expect(r.ok).toBe(true);
    const d = r.data as { image: string; mediaType: string; opts: { page?: number; maxSide?: number } };
    expect(d.image).toBe("UE5H");
    expect(d.mediaType).toBe("image/jpeg");
    expect(d.opts).toEqual({ page: 2, maxSide: 800 }); // параметры команды доходят до актуатора
  });

  it("fs.view: актуатор бросил (не декодировалось/нечем отрендерить/секрет) → error.runtime с причиной, не ok с пустой картинкой", async () => {
    st.view = async () => {
      throw new Error("страницу PDF отрендерить нечем: python не найден на PATH");
    };
    const r = await run({ kind: "fs.view", path: "C:\\tmp\\a.pdf" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("runtime");
    expect(r.error?.message).toContain("отрендерить нечем");
    expect(r.data).toBeUndefined();
  });

  it("window.focus: окно найдено, но фокус не перешёл (focused:false) → ошибка, не ok", async () => {
    st.focusWindow = async () => ({ focused: false, hwnd: 9, title: "Dota 2" });
    st.focus = async () => ({ focused: false });
    const r = await run({ kind: "window.focus", hwnd: 9 });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/фокус/iu);
  });
});

describe("waitFor() — «не смог проверить» ≠ «условие не выполнено»", () => {
  // Таймаут ожидания клампится снизу в 1с — держим сценарии у этой границы, чтобы тесты были быстрыми.
  const T = 1_000;

  it("UIA-условие при ЛЕЖАЩЕМ сайдкаре → met:false + unknown:true (незнание, а не «элемента нет»)", async () => {
    st.sidecarReady = false;
    const w = await waitFor({ kind: "ui", role: "Button", name: "Играть" }, T, 200);
    expect(w.met).toBe(false);
    expect(w.unknown).toBe(true);
    expect(w.detail).toMatch(/сайдкар/iu);
  });

  it("сбой RPC-опроса (сайдкар жив, но не ответил) → unknown:true", async () => {
    st.ground = async () => {
      throw new Error("UIA RPC timeout");
    };
    const w = await waitFor({ kind: "ui", role: "Button", name: "Играть" }, T, 200);
    expect(w.met).toBe(false);
    expect(w.unknown).toBe(true);
  });

  it("ДОСТОВЕРНОЕ «элемент не найден» → met:false БЕЗ unknown (иначе флаг обесценен)", async () => {
    st.ground = async () => {
      throw new Error("элемент не найден");
    };
    const w = await waitFor({ kind: "ui", role: "Button", name: "Играть" }, T, 200);
    expect(w.met).toBe(false);
    expect(w.unknown).toBeFalsy();
    expect(w.detail).toContain("не найден");
  });

  it("ДОСТОВЕРНОЕ «окна нет» → met:false БЕЗ unknown; окно появилось → met:true", async () => {
    const absent = await waitFor({ kind: "window", titleContains: "Dota" }, T, 200);
    expect(absent.met).toBe(false);
    expect(absent.unknown).toBeFalsy();

    st.listWindows = async () => [{ title: "Dota 2", process: "dota2.exe" }];
    const present = await waitFor({ kind: "window", titleContains: "Dota" }, T, 200);
    expect(present.met).toBe(true);
    expect(present.unknown).toBeFalsy();
  });

  it("ЗАВИСШИЙ опрос (захват/OCR не отвечает) → unknown:true и возврат В СРОК, а не через 20с сайдкара", async () => {
    st.capture = () => new Promise<never>(() => {}); // никогда не резолвится — как зависший захват/OCR
    const started = Date.now();
    const w = await waitFor({ kind: "text", text: "Принять" }, T, 500);
    expect(w.met).toBe(false);
    expect(w.unknown).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000); // кап опроса отработал, ожидание не повисло
  }, 15_000);

  it("последний опрос ДОСТОВЕРЕН → unknown снимается (флаг описывает последнее наблюдение)", async () => {
    let n = 0;
    st.ground = async () => {
      n += 1;
      if (n === 1) throw new Error("UIA RPC timeout"); // первый опрос — незнание
      throw new Error("элемент не найден"); // дальше сенсор ожил и отвечает достоверно
    };
    const w = await waitFor({ kind: "ui", role: "Button", name: "Играть" }, T, 200);
    expect(n).toBeGreaterThan(1);
    expect(w.met).toBe(false);
    expect(w.unknown).toBeFalsy();
  });
});

describe("проводка dispatch → wait.for: честный исход доезжает до сервера в data", () => {
  it("сенсор недоступен: ActionResult.ok=true (не сбой транспорта), но data.unknown=true при met:false", async () => {
    st.sidecarReady = false;
    const r = await run({ kind: "wait.for", condition: { kind: "ui", role: "Button", name: "Играть" }, timeoutMs: 1_000, pollMs: 200 });
    expect(r.ok).toBe(true); // «не наступило» — это ДАННЫЕ для модели, а не ошибка канала
    const w = r.data as WaitOutcome;
    expect(w.met).toBe(false);
    expect(w.unknown).toBe(true); // флаг незнания не теряется по дороге (иначе watch решит «отлипло»)
  });

  it("достоверное «условие не выполнено» доезжает БЕЗ unknown", async () => {
    const r = await run({ kind: "wait.for", condition: { kind: "window", titleContains: "Dota" }, timeoutMs: 1_000, pollMs: 200 });
    expect(r.ok).toBe(true);
    const w = r.data as WaitOutcome;
    expect(w.met).toBe(false);
    expect(w.unknown).toBeUndefined();
  });
});

// ── контроль-9: пост-проверка нажатия клавиши и честный note остановленного задания ──
describe("§режим выделения — контроль-9", () => {
  it("presskey-no-veil-postcheck: вуаль открылась ВО ВРЕМЯ RPC нажатия → overlay_drawing с признаком «действие ушло»", async () => {
    selectionStore.setDrawing(false);
    st.sidecarRequest = (async () => {
      selectionStore.setDrawing(true); // владелец нажал Ctrl+Alt+X, пока сайдкар держал клавишу
      return {};
    }) as unknown as typeof st.sidecarRequest;
    const r = await run({ kind: "input.key", combo: "Enter" } as unknown as ActionCommand);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("overlay_drawing"); // до фикса: чистый ok — журнал писал «ok» про несостоявшуюся отправку
    expect(r.stepActionInjected).toBe(true); // нажатие УЖЕ ушло: повторять вслепую нельзя
    selectionStore.setDrawing(false);
  });

  it("job-veil-done0-injected: note не утверждает «уйти ничего не успело», когда действие ушло", async () => {
    st.jobStatus = async () => ({
      jobId: "job-1",
      lang: "python",
      cwd: "C:/",
      running: false,
      exitCode: 77,
      elapsedMs: 5,
      stdoutTail: "",
      stderrTail: "[overlay_drawing] done=0 injected=1 input.click: клик УЖЕ УШЁЛ",
      logDir: "x",
      killed: false,
    });
    const r = await run({ kind: "job.status", jobId: "job-1" } as unknown as ActionCommand);
    const note = String((r.data as { note?: unknown }).note ?? "");
    expect(note).toMatch(/УЖЕ УШЛО/u);
    expect(note).not.toMatch(/уйти ничего не успело/u);
  });

  it("job-caught-marker-lost-in-tail: маркер из ПОЛНОГО stderr виден, даже когда хвост его потерял", async () => {
    st.jobStatus = async () => ({
      jobId: "job-1",
      lang: "python",
      cwd: "C:/",
      running: false,
      exitCode: 0,
      elapsedMs: 5,
      stdoutTail: "",
      stderrTail: "…" + "предупреждение библиотеки\n".repeat(200), // маркер вылетел из окна хвоста
      overlayMarker: "[overlay_drawing] done=0 injected=0 input.click: оверлей",
      logDir: "x",
      killed: false,
    });
    const r = await run({ kind: "job.status", jobId: "job-1" } as unknown as ActionCommand);
    expect((r.data as { overlayCaught?: boolean }).overlayCaught).toBe(true); // до фикса: чистый успех при невыполненных действиях
  });
});

// ── W4 act: проводка gui.act → act() (лист мокается), маппинг частичного исполнения, ранний гейт вуали ──
const actSt = vi.hoisted(() => ({
  act: async (_c: unknown, _o: unknown): Promise<unknown> => ({ did: "x", verified: "met", detail: "d" }),
}));
vi.mock("./act.js", () => ({ act: (c: unknown, o: unknown) => actSt.act(c, o) }));
import { ActPartialError } from "./act-do.js";

describe("W4 act — проводка dispatch", () => {
  it("успех: данные act уходят как есть; restoreCursor = владелец не трогает мышь", async () => {
    let seen: unknown;
    actSt.act = async (c, o) => {
      seen = { c, o };
      return { did: "UIA invoke", verified: "met", detail: "ok" };
    };
    const r = await dispatch("a1", { kind: "gui.act", target: "Отправить" });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ did: "UIA invoke", verified: "met" });
    expect(seen).toMatchObject({ c: { kind: "gui.act", target: "Отправить" }, o: { restoreCursor: true } });
  });

  it("ActPartialError → ok:false runtime + stepActionInjected (клик ушёл, печать упала)", async () => {
    actSt.act = async () => {
      throw new ActPartialError("клик ушёл, печать не удалась");
    };
    const r = await dispatch("a2", { kind: "gui.act", target: "Поиск", do: "type", text: "x" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("runtime");
    expect(r.stepActionInjected).toBe(true);
  });

  it("под вуалью act с app отклоняется ранним гейтом с причиной про фокус; бесшумный act по тексту доходит до act()", async () => {
    selectionStore.setDrawing(true);
    try {
      const calls: unknown[] = [];
      actSt.act = async (c) => {
        calls.push(c);
        return { did: "x", verified: "unchecked", detail: "" };
      };
      const r = await dispatch("a3", { kind: "gui.act", target: "Отправить", app: "Telegram" });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("overlay_drawing");
      expect(r.error?.message).toMatch(/клавиатуру у окна рисования/u);
      expect(calls).toHaveLength(0);
      await dispatch("a4", { kind: "gui.act", target: "Отправить" });
      expect(calls).toHaveLength(1);
    } finally {
      selectionStore.setDrawing(false);
    }
  });
});
