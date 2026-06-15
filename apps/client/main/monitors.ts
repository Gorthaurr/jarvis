/**
 * Менеджер мониторов (§6, мультимонитор). Через Electron `screen` (без нативного кода).
 *
 * Концепция: у Джарвиса есть СВОЙ «рабочий» монитор — туда уходит его видимая активность
 * (окна браузера, запускаемые приложения), чтобы НЕ мешать пользователю на основном экране.
 * По умолчанию это ВТОРИЧНЫЙ монитор (не основной); при одном мониторе — он же основной.
 * Голосом «выведи на основной монитор» — временно цель = основной (пользовательский); «верни
 * на свой / на второй монитор» — обратно. Настройка индекса монитора Джарвиса — persist на диск.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, screen, type Display } from "electron";
import { createLogger } from "@jarvis/shared";

const log = createLogger("monitors");

export type MonitorTarget = "jarvis" | "primary";

interface MonitorConfig {
  /** Индекс монитора Джарвиса в screen.getAllDisplays(); null = авто (вторичный). */
  jarvisIndex: number | null;
}

export class MonitorManager {
  private target: MonitorTarget = "jarvis";
  private cfg: MonitorConfig = { jarvisIndex: null };
  private readonly cfgPath: string;

  constructor(cfgPath?: string) {
    // userData недоступен до app.ready — мягкий фоллбэк на cwd.
    let base = process.cwd();
    try {
      base = app.getPath("userData");
    } catch {
      /* до ready */
    }
    this.cfgPath = cfgPath ?? join(base, "jarvis-monitors.json");
    this.load();
  }

  /** Все дисплеи (порядок Electron). */
  displays(): Display[] {
    return screen.getAllDisplays();
  }

  get hasMultiple(): boolean {
    return this.displays().length > 1;
  }

  /** «Рабочий» монитор Джарвиса: настроенный индекс → вторичный → основной. */
  jarvisDisplay(): Display {
    const all = this.displays();
    const i = this.cfg.jarvisIndex;
    if (i !== null && i >= 0 && i < all.length) return all[i]!;
    const primary = screen.getPrimaryDisplay();
    return all.find((d) => d.id !== primary.id) ?? primary;
  }

  /** Целевой монитор с учётом голосового override. */
  targetDisplay(): Display {
    return this.target === "primary" ? screen.getPrimaryDisplay() : this.jarvisDisplay();
  }

  /** Куда ставить окно: рабочая область (workArea) целевого монитора. */
  targetBounds(): { x: number; y: number; width: number; height: number } {
    return this.targetDisplay().workArea;
  }

  setTarget(t: MonitorTarget): void {
    this.target = t;
    log.info("цель монитора", { target: t });
  }

  get currentTarget(): MonitorTarget {
    return this.target;
  }

  /** Настроить, какой монитор — «Джарвиса» (persist). null = авто (вторичный). */
  setJarvisIndex(i: number | null): void {
    this.cfg.jarvisIndex = i;
    this.save();
    log.info("монитор Джарвиса настроен", { jarvisIndex: i });
  }

  /** Сводка для логов/диагностики. */
  summary(): string {
    const all = this.displays();
    const primary = screen.getPrimaryDisplay();
    const j = this.jarvisDisplay();
    return `мониторов: ${all.length}; Джарвис на ${j.id === primary.id ? "основном" : "вторичном"}; цель: ${this.target}`;
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.cfgPath, "utf8")) as Partial<MonitorConfig>;
      if (typeof raw.jarvisIndex === "number" || raw.jarvisIndex === null) {
        this.cfg.jarvisIndex = raw.jarvisIndex ?? null;
      }
    } catch {
      /* нет файла — дефолт */
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.cfgPath), { recursive: true });
      writeFileSync(this.cfgPath, JSON.stringify(this.cfg), "utf8");
    } catch (e) {
      log.warn("не удалось сохранить конфиг мониторов", e instanceof Error ? e.message : String(e));
    }
  }
}

/** Синглтон менеджера мониторов (на main-процесс). */
export const monitors = new MonitorManager();
