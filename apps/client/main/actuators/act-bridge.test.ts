import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { type ActBridge, BRIDGE_ALLOWED_KINDS, type DispatchFn, startActBridge } from "./act-bridge.js";

/** Поднять мост с мок-dispatch; вернуть его + шпион. Гасим в afterEach. */
let live: ActBridge | null = null;
afterEach(async () => {
  await live?.stop();
  live = null;
});

async function boot(dispatch: DispatchFn): Promise<ActBridge> {
  live = await startActBridge(dispatch);
  return live;
}

function post(bridge: ActBridge, body: unknown, token = bridge.token): Promise<Response> {
  return fetch(`http://127.0.0.1:${bridge.port}/act`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-jarvis-token": token },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("act-bridge (jarvis SDK loopback-мост)", () => {
  it("валидный запрос → dispatch зовётся с командой, результат возвращается JSON", async () => {
    const dispatch = vi.fn(
      async (commandId: string, _cmd: ActionCommand): Promise<ActionResult> => ({ commandId, ok: true, data: { pressed: "r" }, durationMs: 5 }),
    );
    const bridge = await boot(dispatch);
    const res = await post(bridge, { kind: "input.key", combo: "r" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as ActionResult;
    expect(json.ok).toBe(true);
    expect(json.data).toEqual({ pressed: "r" });
    // dispatch получил РОВНО распарсенную команду (kind + поля).
    expect(dispatch).toHaveBeenCalledTimes(1);
    const cmd = dispatch.mock.calls[0]![1] as { kind: string; combo: string };
    expect(cmd.kind).toBe("input.key");
    expect(cmd.combo).toBe("r");
  });

  it("провал актуатора пробрасывается честно (ok:false + error)", async () => {
    const dispatch = vi.fn(
      async (commandId: string): Promise<ActionResult> => ({ commandId, ok: false, error: { code: "not_found", message: "окно не найдено" }, durationMs: 3 }),
    );
    const bridge = await boot(dispatch);
    const json = (await (await post(bridge, { kind: "window.focus", query: "Нет такого" })).json()) as ActionResult;
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe("not_found");
  });

  it("исключение dispatch не роняет мост → ok:false runtime", async () => {
    const dispatch = vi.fn(async (): Promise<ActionResult> => {
      throw new Error("bang");
    });
    const bridge = await boot(dispatch);
    const res = await post(bridge, { kind: "app.launch", app: "x" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as ActionResult;
    expect(json.ok).toBe(false);
    expect(json.error?.message).toContain("bang");
  });

  it("неверный токен → 403, dispatch НЕ зовётся", async () => {
    const dispatch = vi.fn(async (commandId: string): Promise<ActionResult> => ({ commandId, ok: true, durationMs: 1 }));
    const bridge = await boot(dispatch);
    const res = await post(bridge, { kind: "input.key", combo: "r" }, "wrong-token");
    expect(res.status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("битое тело / без kind → 400", async () => {
    const dispatch = vi.fn(async (commandId: string): Promise<ActionResult> => ({ commandId, ok: true, durationMs: 1 }));
    const bridge = await boot(dispatch);
    expect((await post(bridge, "не json")).status).toBe(400);
    expect((await post(bridge, { foo: 1 })).status).toBe(400); // нет kind
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("не POST /act → 404", async () => {
    const dispatch = vi.fn(async (commandId: string): Promise<ActionResult> => ({ commandId, ok: true, durationMs: 1 }));
    const bridge = await boot(dispatch);
    const res = await fetch(`http://127.0.0.1:${bridge.port}/other`, { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("bind ТОЛЬКО на loopback (127.0.0.1) — токен уникален на подъём", async () => {
    const dispatch = vi.fn(async (commandId: string): Promise<ActionResult> => ({ commandId, ok: true, durationMs: 1 }));
    const b1 = await boot(dispatch);
    const t1 = b1.token;
    await b1.stop();
    const b2 = await boot(dispatch);
    expect(b2.token).not.toBe(t1); // per-boot случайный токен
    expect(b2.port).toBeGreaterThan(0);
  });

  // ── allowlist возможностей (ревью HIGH: мост не должен обходить §14-гарды отправки) ──
  describe("allowlist kind (гейт возможностей)", () => {
    it.each(["telegram.send", "message.send", "order.place", "telegram.read", "jbrowser.import_cookies", "code.run", "fs.delete", "system.power", "system.clipboard", "office.excel"])(
      "привилегированный kind '%s' → 403, dispatch НЕ зовётся (даже с валидным токеном)",
      async (kind) => {
        const dispatch = vi.fn(async (commandId: string): Promise<ActionResult> => ({ commandId, ok: true, durationMs: 1 }));
        const bridge = await boot(dispatch);
        const res = await post(bridge, { kind, to: "жертва", text: "x" });
        expect(res.status).toBe(403);
        const json = (await res.json()) as ActionResult;
        expect(json.ok).toBe(false);
        expect(json.error?.code).toBe("denied");
        expect(dispatch).not.toHaveBeenCalled();
      },
    );

    it.each(["app.launch", "input.click", "ui.snapshot", "screen.ocr", "wait.for", "window.list", "input.key", "ui.invoke", "context.read"])(
      "механический/восприятие kind '%s' → проходит в dispatch",
      async (kind) => {
        const dispatch = vi.fn(async (commandId: string): Promise<ActionResult> => ({ commandId, ok: true, durationMs: 1 }));
        const bridge = await boot(dispatch);
        const res = await post(bridge, { kind });
        expect(res.status).toBe(200);
        expect(dispatch).toHaveBeenCalledTimes(1);
      },
    );

    it("allowlist не содержит НИ ОДНОГО привилегированного канала (регресс-защита)", () => {
      for (const forbidden of ["telegram.send", "telegram.read", "message.send", "order.place", "jbrowser.open", "jbrowser.import_cookies", "code.run", "fs.write", "fs.delete", "office.word", "system.power", "system.clipboard"]) {
        expect(BRIDGE_ALLOWED_KINDS.has(forbidden)).toBe(false);
      }
    });
  });
});
