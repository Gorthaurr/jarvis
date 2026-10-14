import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmRequest } from "@jarvis/protocol";
import type { JarvisBridge } from "../main/ipc-contract.js";

const ui = vi.hoisted(() => {
  const nodes = Object.fromEntries([
    "confirmOverlay", "confirmKind", "confirmSummary", "revisionInput", "approveBtn", "reviseBtn", "denyBtn",
  ].map((id) => {
    const classes = new Set(["overlay--hidden"]);
    const node = Object.assign(new EventTarget(), {
      textContent: "", value: "", focus: vi.fn(),
      classList: { add: (s: string) => classes.add(s), remove: (s: string) => classes.delete(s), contains: (s: string) => classes.has(s) },
      click: () => node.dispatchEvent(new Event("click")),
    });
    return [id, node];
  }));
  return { nodes, remember: vi.fn(), restore: vi.fn() };
});
vi.mock("./dom.js", () => ({ $: (id: string) => ui.nodes[id] }));
vi.mock("./focus-trap.js", () => ({ rememberFocus: ui.remember, restoreFocus: ui.restore }));
import { denyConfirm, initConfirmDialog, isConfirmOpen } from "./confirm-dialog.js";

describe("ConfirmDialog — реальная проводка событий к очереди", () => {
  let receive: (request: ConfirmRequest) => void;
  let cleanup: () => void;
  let sent: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  const push = (id: string, ttl = 1000) => receive({ requestId: id, summary: id, kind: "send", expiresAt: Date.now() + ttl });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.clearAllMocks();
    vi.stubGlobal("window", new EventTarget());
    sent = vi.fn();
    unsubscribe = vi.fn();
    cleanup = initConfirmDialog({
      sendConfirmResult: sent,
      onConfirmRequest: (cb) => { receive = cb; return unsubscribe; },
    } as Pick<JarvisBridge, "sendConfirmResult" | "onConfirmRequest"> as JarvisBridge);
  });
  afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("показывает FIFO, сохраняет фокус владельца и отправляет правку нужного вопроса", () => {
    push("a");
    ui.nodes.revisionInput!.value = "короче";
    push("b");
    expect(ui.nodes.confirmSummary!.textContent).toBe("a");
    expect(ui.nodes.revisionInput!.value).toBe("короче");
    ui.nodes.reviseBtn!.click();
    expect(sent).toHaveBeenLastCalledWith({ requestId: "a", approved: false, revision: "короче" });
    expect(ui.nodes.confirmSummary!.textContent).toBe("b");
    expect(ui.nodes.revisionInput!.value).toBe("");
    expect(ui.remember).toHaveBeenCalledTimes(1);
    ui.nodes.approveBtn!.click();
    expect(sent).toHaveBeenLastCalledWith({ requestId: "b", approved: true });
    expect(isConfirmOpen()).toBe(false);
    expect(ui.restore).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deadline закрывает вопрос без ложного отказа владельца и показывает следующий", () => {
    push("a", 100);
    push("b", 200);
    vi.advanceTimersByTime(100);
    expect(ui.nodes.confirmSummary!.textContent).toBe("b");
    expect(sent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(isConfirmOpen()).toBe(false);
    ui.nodes.approveBtn!.click();
    expect(sent).not.toHaveBeenCalled(); // сервер самостоятельно вернёт outcome=expired
  });

  it("двойной клик по первому подтверждению не подтверждает второй запрос", () => {
    push("a");
    push("b");
    ui.nodes.approveBtn!.dispatchEvent(Object.assign(new Event("click"), { detail: 1 }));
    ui.nodes.approveBtn!.dispatchEvent(Object.assign(new Event("click"), { detail: 2 }));
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledWith({ requestId: "a", approved: true });
    expect(ui.nodes.confirmSummary!.textContent).toBe("b");
    expect(isConfirmOpen()).toBe(true);
  });

  it("клик после deadline при задержке таймера не отвечает ни за старый, ни за следующий вопрос", () => {
    push("a", 100);
    push("b", 200);
    vi.setSystemTime(100);
    ui.nodes.approveBtn!.click();
    expect(sent).not.toHaveBeenCalled();
    expect(ui.nodes.confirmSummary!.textContent).toBe("b");
    denyConfirm();
    expect(sent).toHaveBeenCalledWith({ requestId: "b", approved: false });
  });

  it.each(["mousedown", "pointerdown", "keydown"])("%s на A → deadline → click не одобряет B", (type) => {
    push("a", 100);
    push("b", 1000);
    ui.nodes.approveBtn!.dispatchEvent(Object.assign(new Event(type), { key: " ", repeat: false }));
    vi.advanceTimersByTime(100); // таймер уже сменил DOM и activeConfirm на B
    expect(ui.nodes.confirmSummary!.textContent).toBe("b");
    // Совместимый mousedown после pointerdown всё ещё относится к жесту на A.
    if (type === "pointerdown") ui.nodes.approveBtn!.dispatchEvent(new Event("mousedown"));
    const click = Object.assign(new Event("click"), { detail: type === "keydown" ? 0 : 1 });
    Object.defineProperty(click, "isTrusted", { value: true });
    ui.nodes.approveBtn!.dispatchEvent(click);
    expect(sent).not.toHaveBeenCalled();
    expect(isConfirmOpen()).toBe(true);
    denyConfirm(); // программный .click() — отдельное решение владельца уже о B
    expect(sent).toHaveBeenCalledWith({ requestId: "b", approved: false });
  });

  it("фон отклоняет только текущий запрос; закрытие страницы освобождает подписку и таймер", () => {
    push("a");
    push("b");
    ui.nodes.confirmOverlay!.click();
    expect(sent).toHaveBeenCalledWith({ requestId: "a", approved: false });
    window.dispatchEvent(new Event("pagehide"));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(isConfirmOpen()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    ui.nodes.approveBtn!.click();
    expect(sent).toHaveBeenCalledTimes(1);
  });
});
