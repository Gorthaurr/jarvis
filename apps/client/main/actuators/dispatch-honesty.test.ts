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
  focusWindow: async (_o: unknown): Promise<{ focused: boolean; hwnd: number; title: string }> => ({ focused: true, hwnd: 7, title: "X" }),
  listWindows: async (): Promise<Array<{ title: string; process: string }>> => [],
  ground: async (_q: unknown): Promise<{ handle: number }> => ({ handle: 42 }),
  capture: (): Promise<unknown> => Promise.resolve({ image: "b64", width: 100, height: 100 }),
  view: async (_path: string, _opts: unknown): Promise<unknown> => ({ image: "ZmlsZQ==", mediaType: "image/png", width: 1, height: 1, format: "png", bytes: 4, resized: false }),
  sidecarReady: true,
  sidecarRequest: async (): Promise<unknown> => ({ text: "", lines: [] }),
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
vi.mock("./code-runner.js", () => ({ run: () => st.codeRun() }));
vi.mock("./windows.js", () => ({
  listWindows: () => st.listWindows(),
  focusWindow: (o: unknown) => st.focusWindow(o),
}));
vi.mock("./ground.js", () => ({
  ground: (q: unknown) => st.ground(q),
  invoke: async () => undefined,
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
vi.mock("./sidecar-client.js", () => ({
  sidecar: () => ({ ready: st.sidecarReady, request: () => st.sidecarRequest() }),
}));
// Наблюдение после действия (fused observe) в этих сценариях не участвует — глушим, чтобы не лезло в UIA.
vi.mock("./observe.js", () => ({ observeAfterAction: async () => undefined, captureUiFingerprint: async () => undefined }));
// messaging тянет @jarvis/userbots (gramjs/vk-io) — тяжёлый импорт, не нужный ни одному сценарию.
vi.mock("./messaging.js", () => ({ sendMessage: async () => ({ messageId: "1" }), configureSenders: () => undefined }));

import type { ActionCommand } from "@jarvis/protocol";
import { dispatch } from "./index.js";
import { type WaitOutcome, waitFor } from "./sensors-cheap.js";

beforeEach(() => {
  st.launch = async () => ({ launched: true, target: "chrome" });
  st.focus = async () => ({ focused: true });
  st.close = async () => ({ closed: 1 });
  st.codeRun = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  st.focusWindow = async () => ({ focused: true, hwnd: 7, title: "X" });
  st.listWindows = async () => [];
  st.ground = async () => ({ handle: 42 });
  st.capture = () => Promise.resolve({ image: "b64", width: 100, height: 100 });
  st.view = async () => ({ image: "ZmlsZQ==", mediaType: "image/png", width: 1, height: 1, format: "png", bytes: 4, resized: false });
  st.sidecarReady = true;
  st.sidecarRequest = async () => ({ text: "", lines: [] });
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
