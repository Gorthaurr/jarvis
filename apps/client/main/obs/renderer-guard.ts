/**
 * Сторож главного окна (ревью 2026-09-24, H-L2): у BrowserWindow Джарвиса не было ни
 * `render-process-gone`, ни `unresponsive`. А захват микрофона и воспроизведение голоса живут ИМЕННО в
 * renderer (WebRTC AEC, §3) — его падение молча делало Джарвиса глухим и немым: main, транспорт и сервер
 * жили, трей светился, лог молчал, а хранитель супервизора видел здоровый процесс и ничего не чинил.
 *
 * Политика (чистая, тестируется без Electron):
 *  • renderer упал → лог + reload окна с бэкоффом 1 с → 2 с → 4 с…;
 *  • серия (≥3 падения за 5 мин) — перезагрузка окна не помогает → app.relaunch() + app.exit(1): процесс
 *    начинается с чистого листа, а ненулевой код выхода видит хранитель (keeper) супервизора;
 *  • relaunch сам по себе может зациклиться (renderer падает на загрузке) → счётчик перезапусков едет в argv,
 *    после MAX_RELAUNCHES — только exit(1): дальше решает бэкофф и алерт хранителя, а не наш цикл без пауз;
 *  • зависший renderer (unresponsive дольше UNRESPONSIVE_GRACE_MS) принудительно роняется и идёт тем же путём.
 */
export const RELAUNCH_FLAG = "--jarvis-renderer-relaunches";
const WINDOW_MS = 5 * 60_000;
const MAX_IN_WINDOW = 3;
const MAX_RELAUNCHES = 2;
const RELOAD_MIN_MS = 1_000;
const RELOAD_MAX_MS = 30_000;
export const UNRESPONSIVE_GRACE_MS = 20_000;

export type CrashDecision =
  | { action: "reload"; delayMs: number; recent: number }
  | { action: "relaunch" | "exit"; recent: number };

/** Сколько раз процесс уже перезапускал сам себя из-за серии падений renderer (из argv). */
export function relaunchCount(argv: readonly string[]): number {
  const a = argv.find((x) => x.startsWith(`${RELAUNCH_FLAG}=`));
  const n = a ? Number.parseInt(a.slice(RELAUNCH_FLAG.length + 1), 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** argv для app.relaunch: прежние аргументы + счётчик перезапусков (старое значение заменяется). */
export function relaunchArgs(argv: readonly string[], n: number): string[] {
  return [...argv.filter((x) => !x.startsWith(`${RELAUNCH_FLAG}=`)), `${RELAUNCH_FLAG}=${n}`];
}

export class RendererCrashPolicy {
  private crashes: number[] = [];

  constructor(private readonly relaunchesSoFar = 0) {}

  note(now: number): CrashDecision {
    this.crashes = this.crashes.filter((t) => now - t < WINDOW_MS);
    this.crashes.push(now);
    const recent = this.crashes.length;
    if (recent >= MAX_IN_WINDOW) return { action: this.relaunchesSoFar >= MAX_RELAUNCHES ? "exit" : "relaunch", recent };
    return { action: "reload", delayMs: Math.min(RELOAD_MIN_MS * 2 ** (recent - 1), RELOAD_MAX_MS), recent };
  }
}

export interface RendererGuardDeps {
  /** webContents.on("render-process-gone") → (reason). */
  onGone(cb: (reason: string) => void): void;
  onUnresponsive(cb: () => void): void;
  onResponsive(cb: () => void): void;
  /** Окно ещё живо (не destroyed) — перезагрузить страницу. */
  reload(): void;
  /** webContents.forcefullyCrashRenderer(): зависание сводится к пути падения. */
  crashRenderer(): void;
  relaunch(args: string[]): void;
  exit(code: number): void;
  /** Штатный выход: падение/закрытие renderer в этот момент — не авария. */
  isQuitting(): boolean;
  /** Renderer умер вместе с плеером и захватом — снять «звук играет» и т.п. (main/сервер). */
  onRendererLost(): void;
  argv: readonly string[];
  log: { warn(msg: string, meta?: unknown): void; error(msg: string, meta?: unknown): void };
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export function wireRendererGuard(d: RendererGuardDeps): RendererCrashPolicy {
  const now = d.now ?? Date.now;
  const setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const policy = new RendererCrashPolicy(relaunchCount(d.argv));
  let hang: unknown = null;
  const clearHang = (): void => {
    if (hang !== null) clearTimer(hang);
    hang = null;
  };

  d.onGone((reason) => {
    clearHang();
    if (d.isQuitting() || reason === "clean-exit") return;
    d.onRendererLost();
    const dec = policy.note(now());
    if (dec.action === "reload") {
      d.log.warn("renderer упал — слух и голос мертвы; перезагружаю окно", { reason, recent: dec.recent, delayMs: dec.delayMs });
      setTimer(() => {
        if (!d.isQuitting()) d.reload();
      }, dec.delayMs);
      return;
    }
    const next = relaunchCount(d.argv) + 1;
    d.log.error("renderer падает серией — перезапускаю клиент целиком", { reason, recent: dec.recent, action: dec.action, relaunch: next });
    if (dec.action === "relaunch") d.relaunch(relaunchArgs(d.argv, next));
    d.exit(1);
  });

  d.onUnresponsive(() => {
    if (hang !== null) return;
    d.log.warn("renderer не отвечает — жду, затем перезапущу", { graceMs: UNRESPONSIVE_GRACE_MS });
    hang = setTimer(() => {
      hang = null;
      if (d.isQuitting()) return;
      d.log.error("renderer завис дольше порога — роняю принудительно");
      d.crashRenderer();
    }, UNRESPONSIVE_GRACE_MS);
  });
  d.onResponsive(clearHang);
  return policy;
}
