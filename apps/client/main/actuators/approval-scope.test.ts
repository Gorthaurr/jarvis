/**
 * W2 П1: гигиена области одобрения (ALS) — гранты копией, срок, вложенная область act, мост без полей сервера,
 * рестарт сайдкара вне области команды (настоящий процесс: node без аргументов ждёт stdin, как сайдкар).
 *
 * Реверт-проверка:
 *  - гранты по ссылке на конверт (copyGrants → a.grants)                      → «списание не трогает конверт»;
 *  - liveGrants без expiresAt                                                 → «истёкшее одобрение»;
 *  - withExpectedForeground с новой копией грантов                             → «вложенная область делит гранты»;
 *  - bridge-exec без stripServerFields                                        → «мост срезает approval»;
 *  - onRestarted без AsyncResource.bind / рестарт без boot-контекста           → «подписчик рестарта вне области».
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { type ApprovalScope, currentScope, liveGrants, serverExecutor, withExpectedForeground } from "./approval-scope.js";
import { bridgeExecutor } from "./bridge-exec.js";
import { SidecarClient } from "./sidecar-client.js";

const ok = (commandId: string): ActionResult => ({ commandId, ok: true, durationMs: 0 });
const grant = { signature: "key:enter", process: "telegram", count: 2 };

describe("область серверной команды", () => {
  it("гранты — копия: списание в области не трогает конверт команды; вложенная область act делит ТЕ ЖЕ счётчики", async () => {
    const approval = { grants: [{ ...grant }], expiresAt: Date.now() + 60_000 };
    let inner: ApprovalScope | undefined;
    await serverExecutor(async (id) => {
      const scope = currentScope()!;
      scope.grantsLeft![0]!.count -= 1;
      withExpectedForeground({ hwnd: 22, title: "Telegram" }, () => {
        inner = currentScope();
        inner!.grantsLeft![0]!.count -= 1;
      });
      expect(scope.grantsLeft![0]!.count).toBe(0);
      return ok(id);
    })("srv-1", { kind: "input.key", combo: "Enter", approval });
    expect(approval.grants[0]!.count).toBe(2);
    expect(inner).toMatchObject({ via: "server", expectedForeground: { hwnd: 22 } });
    expect(currentScope()).toBeUndefined();
  });

  it("истёкшее одобрение и не-серверная область грантов не дают; мусорный грант отбрасывается", async () => {
    const seen: number[] = [];
    const exec = serverExecutor(async (id) => (seen.push(liveGrants(currentScope()).length), ok(id)));
    await exec("a", { kind: "input.key", combo: "Enter", approval: { grants: [grant], expiresAt: Date.now() - 1 } });
    await exec("b", { kind: "input.key", combo: "Enter", approval: { grants: [grant, { signature: "x", process: "y", count: Number.NaN }], expiresAt: Date.now() + 1_000 } });
    expect(seen).toEqual([0, 1]);
    expect(liveGrants({ via: "bridge", approval: { grants: [grant], expiresAt: Date.now() + 1_000 }, grantsLeft: [grant] })).toEqual([]);
  });
});

describe("мост — поля сервера срезаются, область без одобрения", () => {
  it("approval из тела не доходит до dispatch; область bridge", async () => {
    const seen: Array<{ cmd: ActionCommand; scope: ApprovalScope | undefined }> = [];
    const exec = bridgeExecutor(async (id, cmd) => (seen.push({ cmd, scope: currentScope() }), ok(id)));
    await exec("b1", { kind: "input.key", combo: "Enter", approval: { grants: [grant], expiresAt: Date.now() + 60_000 } } as unknown as ActionCommand);
    expect(seen[0]?.cmd).toEqual({ kind: "input.key", combo: "Enter" });
    expect(seen[0]?.scope).toEqual({ via: "bridge", commandId: "b1" });
  });
});

describe("рестарт сайдкара — в контексте загрузки, не в области упавшей команды", () => {
  let sc: SidecarClient | null = null;
  afterEach(() => {
    sc?.stop();
    sc = null;
  });

  it("сайдкар лениво поднят и подписан ВНУТРИ одобренной команды, упал → рестарт и подписчик — вне любой области", async () => {
    sc = new SidecarClient();
    const client = sc;
    const seen: Array<ApprovalScope | "none"> = [];
    await serverExecutor(async (id) => {
      client.start(process.execPath); // ленивый подъём изнутри команды (контекст спавна — её область)
      client.onRestarted(() => seen.push(currentScope() ?? "none"));
      (client as unknown as { child: { kill(): void } }).child.kill();
      return ok(id);
    })("srv-1", { kind: "input.key", combo: "Enter", approval: { grants: [grant], expiresAt: Date.now() + 60_000 } });
    const until = Date.now() + 5_000;
    while (seen.length < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(["none"]); // до фикса: подписчик видел область команды с грантами
    expect(client.generation).toBe(2);
  }, 10_000);
});
