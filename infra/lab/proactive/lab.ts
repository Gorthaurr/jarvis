/**
 * createProactiveLab - стенд ПРОАКТИВА на виртуальных часах: настоящие ReminderService / WatchService / AmbientEngine /
 * ObligationStore на изолированном каталоге, настоящая очередь озвучки (VoicePipeline) с управляемым TTS и один журнал
 * «что прозвучало / что в очереди / какие поручения ушли» с метками виртуального времени.
 * Пример:  const lab = await createProactiveLab(); const o = lab.connect(); lab.svc.reminders.add({...}); await lab.clock.advance(5_000);
 */
import { createLabDir } from "../tools/isolation.js"; // ПЕРВЫМ среди модулей продукта (см. services.ts)
import { existsSync, rmSync } from "node:fs";
import { AutonomyFreeze, setAutonomyFreezeForTests } from "../../../apps/server/src/autonomy/freeze.js";
import { AutonomyThrottle, setAutonomyThrottleForTests } from "../../../apps/server/src/autonomy/throttle.js";
import { type LabClock, installClock } from "./clock.js";
import { Journal } from "./journal.js";
import { captureLogs } from "./logs.js";
import { FAULT } from "./kit.js";
import { type LabOptions, type Script, type Services, buildServices, newScript, startServices, stopServices } from "./services.js";
import { FakeTts } from "./tts-fake.js";
import { type Owner, type OwnerOpts, type PredicateState, connectOwner, predicateSender } from "./wire.js";

export type { LabOptions } from "./services.js";

/** Файлы, которые рестарт при неисправности "amnesia" теряет (честная поломка durable, не продукта). */
const DURABLE = ["reminders.json", "watches.json", "ambient-seen.json", "obligations.json", "autonomy-freeze.json"];

export interface ProactiveLab {
  clock: LabClock;
  dataDir: string;
  journal: Journal;
  /** Строки лога продукта (консоль перехвачена на время прогона). */
  logs: string[];
  tts: FakeTts;
  script: Script;
  /** Текущие сервисы; после crash()/restart() - НОВЫЕ экземпляры (ссылки старых брать нельзя). */
  readonly svc: Services;
  predicate: PredicateState;
  connect(o?: OwnerOpts): Owner;
  /** Запуск сервисов (в createProactiveLab по умолчанию уже сделан). */
  boot(): Promise<void>;
  /** Дозапись сторов на диск (asyncный persist не ждёт таймеров). */
  flush(): Promise<void>;
  /** Штатный рестарт: остановка таймеров + flush + новые экземпляры (сессии владельца не переживают). */
  restart(downMs?: number): Promise<void>;
  /** Смерть процесса: ничего не останавливается штатно, таймеры и ОЗУ пропадают, на диске - что успело записаться. */
  crash(downMs?: number): Promise<void>;
  /** Тексты, что реально прозвучали (после verbalize). */
  spoken(): string[];
  close(): Promise<void>;
}

export async function createProactiveLab(o: LabOptions & { boot?: boolean } = {}): Promise<ProactiveLab> {
  const capture = captureLogs();
  const clock = installClock(o.start ?? "2026-07-29T08:00:00", o.tz ?? "Europe/Moscow");
  const labDir = createLabDir("proactive-");
  const dataDir = labDir.dataDir;
  const script = newScript();
  const journal = new Journal();
  const tts = new FakeTts();
  const predicate: PredicateState = { met: false, calls: 0 };
  setAutonomyFreezeForTests(new AutonomyFreeze(dataDir));
  setAutonomyThrottleForTests(new AutonomyThrottle(o.llmPerHour ?? 0, () => Date.now()));
  let svc = buildServices(dataDir, o, script);

  const swap = async (): Promise<void> => {
    svc = buildServices(dataDir, o, script);
    setAutonomyFreezeForTests(new AutonomyFreeze(dataDir)); // новый процесс читает латч с диска заново
    await startServices(svc);
  };
  const lab: ProactiveLab = {
    clock, dataDir, journal, tts, script, predicate, logs: capture.lines,
    get svc() {
      return svc;
    },
    connect: (opts) => connectOwner({ svc, journal, tts }, { ...opts, predicate: opts?.predicate ?? predicateSender(journal, predicate) }),
    boot: () => startServices(svc),
    flush: async () => void (await Promise.all(svc.stores.map((s) => s.flush()))),
    async restart(downMs = 0) {
      await stopServices(svc);
      clock.wipeTimers(); // хвосты дренажа/TTS старого «процесса» не должны шуметь в новом
      clock.jump(downMs);
      journal.add("mark", { text: `restart (простой ${downMs} мс)` });
      wipeIfAmnesia(dataDir);
      await swap();
    },
    async crash(downMs = 0) {
      await lab.flush(); // запись, уже отданная ФС, доезжает; дальше процесса нет
      clock.wipeTimers();
      clock.jump(downMs);
      journal.add("mark", { text: `crash (простой ${downMs} мс)` });
      wipeIfAmnesia(dataDir);
      await swap();
    },
    spoken: () => journal.spoken(),
    async close() {
      await stopServices(svc).catch(() => undefined);
      setAutonomyFreezeForTests(undefined);
      setAutonomyThrottleForTests(undefined);
      clock.restore();
      capture.restore();
      labDir.remove();
    },
  };
  if (o.boot !== false) await lab.boot();
  return lab;
}

function wipeIfAmnesia(dataDir: string): void {
  if (FAULT !== "amnesia") return;
  for (const f of DURABLE) if (existsSync(`${dataDir}/${f}`)) rmSync(`${dataDir}/${f}`);
}
