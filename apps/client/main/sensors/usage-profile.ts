/**
 * W4.2 «Руки» (2026-09-10): НАКОПИТЕЛЬ ФОКУСА — сколько минут каждое приложение было на переднем плане.
 *
 * Зачем: ревью §7 просит «рецепты для 20 самых частых программ владельца», а Windows на этой машине про частоту
 * молчит — UserAssist почти пуст (единицы запусков), Prefetch пуст. Единственный честный источник «чаще всего» —
 * считать самим: снимок ПК (`sensors/system-snapshot.captureAmbient`) и так каждые 12 с знает процесс переднего
 * окна. Здесь он превращается в durable-счётчик секунд по процессу; топ уезжает в `client.env.usage`, и сервер
 * упорядочивает по нему реестр программных каналов и честно называет, у каких частых программ канала нет.
 *
 * Это ИСТОЧНИК ДАННЫХ, не фича: никаких выводов о «частоте» до накопления (поле days говорит, сколько дней
 * считалось), окна Джарвиса уже отфильтрованы снимком (isNoise), «unknown» не считается.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "@jarvis/shared";

const log = createLogger("sensors:usage");

export interface UsageEntry {
  process: string;
  minutes: number;
  /** Сколько дней ведётся счёт (с момента первой записи) — честная граница «частоты». */
  days: number;
}

interface Persisted {
  v: 1;
  since: number;
  seconds: Record<string, number>;
}

/** Присутствие владельца — как его считает `actuators/user-presence.ownerPresence`. */
export type OwnerPresenceState = "at_pc" | "away" | "unknown";

/**
 * Ревью 2026-09-24 (H-W1): фокус считается ТОЛЬКО пока владелец за ПК. Раньше тик шёл каждые 12 с при
 * любом состоянии: ночь с открытым браузером, экран блокировки, окна, которые двигал САМ Джарвис во время
 * GUI-задачи, — всё уходило в «самые частые программы владельца», и порядок каналов на сервере строился
 * по чужой активности. «unknown» (последний ввод — наш) тоже не считаем: это работа Джарвиса, не владельца.
 * Блокировку проверяем отдельно: первые ~60 с после неё простой ещё мал, и присутствие говорит «за ПК».
 */
export function focusCountable(presence: OwnerPresenceState, locked: boolean): boolean {
  return presence === "at_pc" && !locked;
}

/** Кап процессов в сторе: лишние (самые редкие) вытесняются, чтобы файл не рос вечно. */
const MAX_PROCESSES = 200;
/** Дебаунс записи на диск: тики каждые 12 с, писать каждый — лишнее. */
const SAVE_DEBOUNCE_MS = 30_000;

export class UsageProfile {
  private seconds = new Map<string, number>();
  private since: number;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly path: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.since = this.now();
    this.load();
  }

  /** Тик снимка: процесс переднего окна был в фокусе ещё `ms` миллисекунд. Неизвестный процесс не считается. */
  tick(process: string | undefined, ms: number): void {
    const p = (process ?? "").trim();
    if (!p || p === "unknown" || !Number.isFinite(ms) || ms <= 0) return;
    this.seconds.set(p, (this.seconds.get(p) ?? 0) + ms / 1000);
    if (this.seconds.size > MAX_PROCESSES) this.evict();
    this.scheduleSave();
  }

  /** H-W1: тик снимка с учётом присутствия владельца. true — посчитан. */
  tickFocus(process: string | undefined, ms: number, ctx: { presence: OwnerPresenceState; locked: boolean }): boolean {
    if (!focusCountable(ctx.presence, ctx.locked)) return false;
    this.tick(process, ms);
    return true;
  }

  /** Топ-N по минутам фокуса (убывание). days — с момента первой записи, не меньше 1 после суток. */
  top(n: number): UsageEntry[] {
    const days = Math.max(0, Math.round(((this.now() - this.since) / 86_400_000) * 10) / 10);
    return [...this.seconds.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, n))
      .map(([process, sec]) => ({ process, minutes: Math.round(sec / 60), days }));
  }

  /** Записать на диск немедленно (выход приложения). Провал — WARN, данные живут в памяти. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const data: Persisted = { v: 1, since: this.since, seconds: Object.fromEntries(this.seconds) };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(data), "utf8");
    } catch (e) {
      log.warn("профиль фокуса не записан", e instanceof Error ? e.message : String(e));
    }
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Persisted>;
      if (raw && raw.v === 1 && raw.seconds && typeof raw.seconds === "object") {
        for (const [k, v] of Object.entries(raw.seconds)) if (typeof v === "number" && Number.isFinite(v) && v > 0) this.seconds.set(k, v);
        if (typeof raw.since === "number" && Number.isFinite(raw.since) && raw.since > 0 && raw.since <= this.now()) this.since = raw.since;
      }
    } catch {
      /* нет файла или битый JSON — начинаем заново; это не ошибка */
    }
  }

  private evict(): void {
    const sorted = [...this.seconds.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of sorted.slice(0, this.seconds.size - MAX_PROCESSES)) this.seconds.delete(k);
  }

  private scheduleSave(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }
}
