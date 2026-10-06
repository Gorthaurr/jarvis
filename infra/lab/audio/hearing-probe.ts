import type { Logger } from "@jarvis/shared";
/** Что слух сделал за прогон (сбрасывается `begin()`); из публичных швов, без чтения приватных членов координатора. */
export class HearingProbe {
  wakeFired = false;
  wakeKeywords: string[] = [];
  gateOpened = false;
  gateOpenReasons: string[] = [];
  rescueSent = false;
  rescueCount = 0;
  rescueVerdict: "accepted" | "bare" | undefined;
  framesSent = 0;
  vad: string[] = [];
  bargeIns = 0;
  log: string[] = [];
  private t0 = Date.now();

  begin(): void {
    Object.assign(this, { wakeFired: false, wakeKeywords: [], gateOpened: false, gateOpenReasons: [], rescueSent: false, rescueCount: 0, rescueVerdict: undefined, framesSent: 0, vad: [], bargeIns: 0, log: [] });
    this.t0 = Date.now();
  }

  line(level: string, msg: string): void {
    this.log.push(`+${Date.now() - this.t0}мс ${level} ${msg}`);
    if (msg.startsWith("гейт микрофона ОТКРЫТ")) this.gateOpened = true;
  }
}

/** Логгер, пишущий в hearing.log (child возвращает себя). */
export function probeLogger(p: HearingProbe): Logger {
  const mk = (level: string) => (msg: string, meta?: unknown): void => {
    let m = msg;
    if (meta && typeof meta === "object") m += ` ${JSON.stringify(meta)}`;
    p.line(level, m);
    if (level === "info" && msg.startsWith("гейт микрофона ОТКРЫТ") && meta && typeof meta === "object") p.gateOpenReasons.push(String((meta as { reason?: unknown }).reason));
  };
  const l: Logger = { debug: () => { }, info: mk("info"), warn: mk("warn"), error: mk("error"), child: () => l };
  return l;
}

/** Часы координатора: реальные или виртуальные (монотонные при переключении). */
export class RigClock {
  private virtual = false;
  private v = 0;
  private last = 0;
  now = (): number => {
    const t = this.virtual ? this.v : Date.now();
    this.last = Math.max(this.last, t);
    return this.last;
  };
  use(realtime: boolean): void {
    if (realtime === !this.virtual) return;
    this.virtual = !realtime;
    if (this.virtual) this.v = Math.max(Date.now(), this.last);
  }
  tick(ms: number): void {
    this.v += ms;
  }
}
