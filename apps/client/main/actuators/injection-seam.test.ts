/**
 * W2 (пакет 0): РУБЕЖ В ТОЧКЕ ИНЖЕКЦИИ — проводка. Каждая мутирующая операция сайдкара (type, key, click ×3, mouse,
 * invoke) проходит через injection-guard ДО отправки; отказ судьи = ни одной мутации в сайдкаре, а dispatch отдаёт
 * протокольный `denied` + данные вопроса. Гейт вуали — первым (судьи не зовутся). Судьи — по порядку, первый отказ
 * побеждает; область одобрения — из транспорта.
 * Реверт-проверка: верни в любом из семи мест `sidecar().request` вместо `injectRpc` — мутация дойдёт до фейка.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import type { FakeSidecar } from "../test-support/fake-sidecar.js";

vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
vi.mock("./sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());

type Case = { op: string; params: Record<string, unknown>; scope?: { via: string; approval?: unknown } };
const j = vi.hoisted(() => ({
  seen: [] as Array<{ judge: string; op: string; scope?: unknown }>,
  deny: {} as Record<string, ((c: Case) => { message: string; data?: unknown } | null) | undefined>,
}));
const judgeMock = (name: string) => async (c: Case) => {
  j.seen.push({ judge: name, op: c.op, scope: c.scope });
  return j.deny[name]?.(c) ?? null;
};
vi.mock("./self-judge.js", () => ({ selfJudge: (c: Case) => judgeMock("self")(c) }));
vi.mock("./secret-judge.js", () => ({ secretJudge: (c: Case) => judgeMock("secret")(c) }));
vi.mock("./commit-judge.js", () => ({ commitJudge: (c: Case) => judgeMock("commit")(c) }));

import { useFakeSidecar } from "../test-support/fake-sidecar.js";
import { resetElectronMock } from "../test-support/electron-mock.js";
import { selectionStore } from "../selection/store.js";
import { DrawingOverlayError } from "../selection/overlay-error.js";
import { click, mouse, pressKey, resetHeldKeys, typeText } from "./input.js";
import { invoke } from "./ground.js";
import { InjectionDeniedError } from "./injection-guard.js";
import { serverExecutor, runWithoutApproval } from "./approval-scope.js";
import { dispatch } from "./index.js";

let fake: FakeSidecar;
const denyAll = (c: Case) => ({ message: `§14: ${c.op} без гранта`, data: { needsApproval: { signature: "key:enter", process: "telegram", category: "messenger", what: "Enter" } } });

beforeEach(() => {
  fake = useFakeSidecar();
  fake.snapshot = { window: "Telegram", pid: 7, items: [{ handle: 41, role: "button", name: "Отправить", x: 10, y: 10, w: 80, h: 30 }], truncated: false };
  resetElectronMock();
  resetHeldKeys();
  selectionStore.setDrawing(false);
  j.seen = [];
  j.deny = {};
});

describe("семь мест инжекции — через рубеж", () => {
  const ops: Array<[string, string, () => Promise<unknown>]> = [
    ["type", "typeText", () => typeText("привет")],
    ["key", "pressKey", () => pressKey("Enter")],
    ["click", "click coords (физ.)", () => click({ by: "coords", x: 5, y: 5, space: "screen" }, "physical")],
    ["click", "click handle (физ.)", () => click({ by: "handle", handle: "41" }, "physical")],
    ["click", "click role (физ.)", () => click({ by: "role", role: "button", name: "Отправить" }, "physical")],
    ["mouse", "mouse", () => mouse({ op: "move", x: 1, y: 1, space: "screen" })],
    ["invoke", "invoke (UIA)", () => invoke({ by: "handle", handle: "41" }, "invoke")],
  ];

  it.each(ops)("%s ← %s: отказ судьи → ни одной мутации в сайдкаре", async (op, _label, run) => {
    j.deny.commit = denyAll;
    await expect(run()).rejects.toBeInstanceOf(InjectionDeniedError);
    expect(fake.mutations()).toEqual([]);
    expect(j.seen.filter((s) => s.judge === "commit").map((s) => s.op)).toEqual([op]);
  });

  it.each(ops)("%s ← %s: судьи молчат → ровно одна мутация с прежними параметрами", async (op, _label, run) => {
    await run();
    expect(fake.mutations().map((c) => c.op)).toEqual([op]);
    expect(j.seen.map((s) => s.judge)).toEqual(["self", "secret", "commit"]);
  });

  it("бесшумный клик по handle (UIA invoke) тоже судится — как invoke", async () => {
    j.deny.commit = denyAll;
    await expect(click({ by: "handle", handle: "41" })).rejects.toThrow();
    expect(fake.mutations()).toEqual([]);
    expect(j.seen.some((s) => s.op === "invoke")).toBe(true);
  });
});

describe("порядок и приоритеты", () => {
  it("вуаль первой: DrawingOverlayError, судьи не зовутся, мутаций нет", async () => {
    selectionStore.setDrawing(true);
    try {
      await expect(typeText("x")).rejects.toBeInstanceOf(DrawingOverlayError);
      expect(j.seen).toEqual([]);
      expect(fake.mutations()).toEqual([]);
    } finally {
      selectionStore.setDrawing(false);
    }
  });

  it("self раньше secret раньше commit: первый отказ побеждает, остальные не зовутся", async () => {
    j.deny.self = () => ({ message: "своё окно" });
    j.deny.commit = denyAll;
    await expect(pressKey("Enter")).rejects.toMatchObject({ judge: "self", actionCode: "denied" });
    expect(j.seen.map((s) => s.judge)).toEqual(["self"]);
  });

  it("одобрение судья видит ТОЛЬКО из области серверной команды; мост внутри неё — без одобрения", async () => {
    const approval = { grants: [{ signature: "key:enter", process: "telegram", count: 1 }], expiresAt: Date.now() + 60_000 };
    const exec = serverExecutor(async (id: string, cmd: ActionCommand) => {
      await pressKey((cmd as { combo: string }).combo);
      await runWithoutApproval("bridge", () => pressKey("a"));
      return { commandId: id, ok: true, durationMs: 0 };
    });
    await exec("c1", { kind: "input.key", combo: "Enter", approval });
    const scopes = j.seen.filter((s) => s.judge === "commit").map((s) => s.scope as { via: string; approval?: unknown });
    expect(scopes[0]).toMatchObject({ via: "server", approval });
    expect(scopes[1]).toEqual({ via: "bridge" });
    await pressKey("b"); // вне любой области
    expect(j.seen.at(-1)?.scope).toBeUndefined();
  });
});

describe("dispatch: отказ рубежа — протокольный denied с данными вопроса", () => {
  it("input.key Enter → ok:false, code denied, data.needsApproval, без stepActionInjected; сайдкар мутаций не видел", async () => {
    j.deny.commit = denyAll;
    const r = await dispatch("c9", { kind: "input.key", combo: "Enter", origin: "user" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("denied");
    expect(r.data).toMatchObject({ needsApproval: { signature: "key:enter", process: "telegram" } });
    expect(r.stepActionInjected).toBeUndefined();
    expect(fake.mutations()).toEqual([]);
  });
});
