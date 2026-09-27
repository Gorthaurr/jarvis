/**
 * W2 (пакет 0): ФЕЙКОВЫЙ САЙДКАР в РЕАЛЬНОЙ форме ответов (apps/sidecar-win/Ipc.cs) + журнал вызовов.
 *
 * Закон «фикстура = реальная форма входа»: прежние моки отдавали `ground.at` как {handle:"77", bbox:{…}}, а настоящий
 * сайдкар — ПЛОСКО {handle:77, x, y, w, h, name, role:"ControlType.Button"}; тесты были зелёными, а проверка контейнера
 * в бою не работала. Здесь формы такие, как у C#:
 *  - ground / ground.at → {handle (число), x, y, w, h (физика), name, role: "ControlType.X"};
 *  - ui.snapshot → {window, pid, items:[{handle (число), role: короткая «button», name, automationId, value, x,y,w,h}], truncated};
 *  - window.list → {windows:[{hwnd, pid, process, title, foreground, minimized, x,y,w,h}]} в z-порядке СВЕРХУ ВНИЗ;
 *  - read.screen / read.window → {text: «ControlType.Edit: Пароль [ЗАЩИЩЕНО]\n…», truncated};
 *  - мутации (type/key/click/mouse/invoke) → {success:true}; неизвестная операция → ошибка, как у C#.
 *
 * Подключение в тесте:
 *   vi.mock("../actuators/sidecar-client.js", async () => (await import("../test-support/fake-sidecar.js")).fakeSidecarModule());
 *   beforeEach(() => { fake = useFakeSidecar(); });
 */

export const MUTATING_OPS: ReadonlySet<string> = new Set(["type", "key", "click", "mouse", "invoke"]);

export interface FakeWindow {
  hwnd: number;
  pid: number;
  process: string;
  title: string;
  foreground?: boolean;
  minimized?: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Элемент UIA: роль — как у снапшота (короткая «button»); ground отдаёт её «ControlType.Button». */
export interface FakeElement {
  handle: number;
  role: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  automationId?: string | null;
  value?: string | null;
}

export interface FakeCall {
  op: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
}

const controlType = (role: string): string => `ControlType.${role.charAt(0).toUpperCase()}${role.slice(1)}`;
const groundForm = (e: FakeElement) => ({ handle: e.handle, x: e.x, y: e.y, w: e.w, h: e.h, name: e.name, role: controlType(e.role) });

export class FakeSidecar {
  ready = true;
  generation = 1;
  readonly calls: FakeCall[] = [];
  /** Окна в z-порядке сверху вниз (как EnumWindows). */
  windows: FakeWindow[] = [];
  /** Снапшот активного окна (pid — корня). */
  snapshot: { window: string; pid: number; items: FakeElement[]; truncated: boolean } = { window: "", pid: 0, items: [], truncated: false };
  /** Выжимка read.screen (первая строка — элемент в фокусе). */
  focusedText = "";
  /** Элемент под точкой (логические DIP); по умолчанию — первый элемент снапшота, чей bbox содержит точку. */
  at: (x: number, y: number) => FakeElement | null = (x, y) => this.snapshot.items.find((e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h) ?? null;
  ocr: { text: string; lines: Array<{ text: string; x: number; y: number; w: number; h: number }> } = { text: "", lines: [] };
  /** Переопределить ответ операции (или бросить) — для сбоев и таймаутов. */
  handlers: Record<string, (args: Record<string, unknown>) => unknown> = {};

  request(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    if (!this.ready) throw new Error("sidecar не готов");
    this.calls.push({ op, args, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    try {
      return Promise.resolve(this.respond(op, args));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** Мутирующие вызовы (то, что реально ушло бы в GUI). */
  mutations(): FakeCall[] {
    return this.calls.filter((c) => MUTATING_OPS.has(c.op));
  }

  count(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  private respond(op: string, args: Record<string, unknown>): unknown {
    const h = this.handlers[op];
    if (h) return h(args);
    if (MUTATING_OPS.has(op)) return { success: true };
    switch (op) {
      case "window.list":
        return { windows: this.windows.map((w) => ({ foreground: false, minimized: false, ...w })) };
      case "window.focus": {
        const q = String(args.query ?? "").toLowerCase();
        const w = this.windows.find((x) => (args.hwnd ? x.hwnd === args.hwnd : x.title.toLowerCase().includes(q) || x.process.toLowerCase().includes(q)));
        if (!w) throw new Error(`Окно не найдено: ${q}`);
        return { focused: true, hwnd: w.hwnd, title: w.title, x: w.x, y: w.y, w: w.w, h: w.h };
      }
      case "ui.snapshot":
        return { ...this.snapshot, items: this.snapshot.items.map((e) => ({ automationId: null, value: null, ...e })) };
      case "ground": {
        const e = this.snapshot.items.find((x) => x.role.toLowerCase() === String(args.role ?? "").toLowerCase() && (args.name === undefined || x.name === args.name));
        if (!e) throw new Error(`Элемент не найден: role=${String(args.role)}, name=${String(args.name ?? "<any>")}`);
        return groundForm(e);
      }
      case "ground.at": {
        const e = this.at(Number(args.x), Number(args.y));
        if (!e) throw new Error(`Под точкой (${String(args.x)},${String(args.y)}) нет UIA-элемента (canvas/игра?).`);
        return groundForm(e);
      }
      case "read.screen":
      case "read.window":
        return { text: this.focusedText, truncated: false };
      case "read.selection":
        return { text: "" };
      case "ocr":
        return this.ocr;
      default:
        throw new Error(`Неизвестная операция: ${op}`);
    }
  }
}

let current: FakeSidecar = new FakeSidecar();

/** Новый фейк на тест (журнал чистый). */
export function useFakeSidecar(): FakeSidecar {
  current = new FakeSidecar();
  return current;
}

/** Модуль-замена `actuators/sidecar-client.js` для vi.mock. */
export function fakeSidecarModule(): { sidecar: () => FakeSidecar } {
  return { sidecar: () => current };
}
