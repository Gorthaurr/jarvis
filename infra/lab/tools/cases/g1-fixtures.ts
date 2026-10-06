/**
 * Общее для кейсов G1 (приложения, окна, зрение): типовые рабочие столы и «ПК» с записанными действиями ВЛАДЕЛЬЦА.
 * Формат кейса не умеет `userAction` (обвести область, двинуть мышь), а без него не проверить режим выделения по
 * существу — поэтому кладём готовый FakeDesktop в `lab` (раннер передаёт `c.lab` в createToolLab как есть).
 */
import { createFakeDesktop } from "../../desktop/index.js";
import type { DesktopSeed, FakeDesktop } from "../../lib/contracts.js";
import type { ToolCase } from "../case-format.js";

type Lab = NonNullable<ToolCase["lab"]>;

/** Три окна: два «тёзки» Word, свёрнутая музыка и Telegram на втором мониторе (последнее окно seed — переднее). */
export const DESK: DesktopSeed = {
  windows: [
    { title: "Отчёт — Word", process: "winword" },
    { title: "Отчёт — Word (копия)", process: "winword" },
    { title: "Музыка", process: "spotify", minimized: true },
    { title: "Чат — Telegram", process: "Telegram", monitor: 2, rect: { x: 2700, y: 100, w: 900, h: 700 } },
  ],
};

/** Блокнот в известном месте: заголовок читается OCR, поле ввода — часть сцены. */
export const NOTEPAD_SEED: DesktopSeed = { windows: [{ title: "Заметки — Блокнот", process: "notepad", text: "план на день", rect: { x: 300, y: 150, w: 900, h: 600 } }] };

export const titleOfForeground = (s: { windows: Array<{ hwnd: number; title: string }>; foregroundHwnd: number | null }): string | undefined =>
  s.windows.find((w) => w.hwnd === s.foregroundHwnd)?.title;

/**
 * «ПК» с действиями владельца, записанными в `script`. Свежий FakeDesktop на КАЖДУЮ лабораторию (её первый шаг —
 * `onEffect`): кейс не зависит от того, сколько раз его запускали в процессе. Эффекты сценария в проверку не идут
 * (подписка на эффекты появляется уже после него).
 */
export function ownerLab(seed: DesktopSeed, script: (d: FakeDesktop) => void): Lab {
  let inner: FakeDesktop | undefined;
  const cur = (): FakeDesktop => {
    if (!inner) throw new Error("ownerLab: «ПК» ещё не создан (харнесс не подписался на эффекты)");
    return inner;
  };
  const desktop: FakeDesktop = {
    handle: (c, m) => cur().handle(c, m),
    snapshot: () => cur().snapshot(),
    reset: (s) => {
      cur().reset(s ?? seed);
      script(cur());
    },
    advance: (ms) => cur().advance(ms),
    userAction: (k, d) => cur().userAction(k, d),
    onEffect: (cb) => {
      inner = createFakeDesktop(seed);
      script(inner);
      return inner.onEffect(cb);
    },
  };
  return { desktop } as unknown as Lab; // `desktop` в lab — разрешённая раннером подмена «ПК», тип Pick её не знает
}

/**
 * Данные ответа FakeDesktop на цепочку команд (последняя даёт результат) — эталон для сравнения: «сервер прислал ровно то,
 * что дал бы клиент на эту команду». Свой FakeDesktop, кейсов не касается; провал любой команды — исключение при загрузке.
 */
export async function fakeData(seed: DesktopSeed, cmds: Array<Record<string, unknown>>): Promise<Record<string, any>> {
  const d = createFakeDesktop(seed);
  let last: Record<string, any> = {};
  for (const [i, c] of cmds.entries()) {
    const r = await d.handle(c as never, { commandId: `g1-${i}`, timeoutMs: 15_000 });
    if (!r.ok) throw new Error(`fakeData: ${String(c.kind)} провалилась: ${r.error?.message}`);
    last = (r.data ?? {}) as Record<string, any>;
  }
  return last;
}

/**
 * Клиент, который не отвечает по-человечески: канал лёг (channel_down), команда зависла (timeout), сессия закрыта
 * (disconnected). Подменяет ctx.session целиком — команды до FakeDesktop не доходят, поэтому `actionKinds` в таких кейсах
 * НЕ проверяются (журнал моста пуст всегда), а проверяется честность ответа сервера.
 */
export function silentClient(code: "channel_down" | "timeout" | "disconnected"): Lab {
  const sendAction = async () => ({ commandId: "lab", ok: false, durationMs: 1, error: { code, message: `лаборатория: ${code}` } });
  return { ctx: { session: { sendAction } as never } };
}
