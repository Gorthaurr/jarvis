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
import type { MonitorInfo, MonitorList } from "@jarvis/protocol";

const log = createLogger("monitors");

export type MonitorTarget = "jarvis" | "primary";

interface MonitorConfig {
  /** Индекс монитора Джарвиса в screen.getAllDisplays(); null = авто (вторичный). */
  jarvisIndex: number | null;
}

export class MonitorManager {
  private target: MonitorTarget = "jarvis";
  private cfg: MonitorConfig = { jarvisIndex: null };
  /** Ленивый резолв (§M10): до первого обращения к cfgPath конструктор НЕ трогает app.getPath. */
  private resolvedCfgPath: string | null = null;
  private loaded = false;
  /** Хук перепозиционирования окна Джарвиса (регистрирует main). Зовётся при смене цели/индекса. */
  private onRelayout?: () => void;

  constructor(cfgPath?: string) {
    // Явный путь (тесты) — используем как есть, без обращения к app.getPath.
    if (cfgPath) {
      this.resolvedCfgPath = cfgPath;
      this.load();
    }
    // Без явного пути резолв откладывается до первого реального доступа (после app.ready) —
    // конструктор синглтона зовётся на import-time, ДО app.whenReady(), когда app.getPath('userData')
    // бросает и раньше давал перманентный фоллбэк на cwd.
  }

  /** Путь конфига: явный — сразу; иначе резолвится лениво (и только раз) при первом доступе. */
  private get cfgPath(): string {
    if (this.resolvedCfgPath) return this.resolvedCfgPath;
    let base = process.cwd();
    try {
      base = app.getPath("userData");
    } catch {
      /* всё ещё до ready — фоллбэк на cwd в ЭТОТ раз, но не запоминаем как окончательный */
      return join(base, "jarvis-monitors.json");
    }
    this.resolvedCfgPath = join(base, "jarvis-monitors.json");
    if (!this.loaded) this.load();
    return this.resolvedCfgPath;
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

  /**
   * Какому монитору принадлежит окно (по ЦЕНТРУ его прямоугольника) — индекс СОГЛАСОВАН с
   * screen_capture/monitor_list (тот же screen.getAllDisplays()). rect — ФИЗИЧЕСКИЕ пиксели (Win32);
   * переводим центр в DIP (screenToDipPoint), т.к. getDisplayNearestPoint ждёт логические координаты.
   */
  displayForRect(rect: { x: number; y: number; width: number; height: number }): {
    index: number;
    display: Display;
    label: string;
    primary: boolean;
    jarvis: boolean;
  } {
    const all = this.displays();
    const cxPhys = Math.round(rect.x + rect.width / 2);
    const cyPhys = Math.round(rect.y + rect.height / 2);
    let display: Display;
    try {
      const dip = screen.screenToDipPoint({ x: cxPhys, y: cyPhys });
      display = screen.getDisplayNearestPoint({ x: Math.round(dip.x), y: Math.round(dip.y) });
    } catch {
      display = screen.getPrimaryDisplay();
    }
    const idx = all.findIndex((d) => d.id === display.id);
    const index = idx >= 0 ? idx : 0;
    const primary = screen.getPrimaryDisplay();
    return {
      index,
      display: all[index] ?? display,
      label: this.labelFor(all[index] ?? display, index, primary),
      primary: display.id === primary.id,
      jarvis: display.id === this.jarvisDisplay().id,
    };
  }

  /** Куда ставить окно: рабочая область (workArea) целевого монитора. */
  targetBounds(): { x: number; y: number; width: number; height: number } {
    return this.targetDisplay().workArea;
  }

  /** Регистрация хука перепозиционирования окна (main передаёт функцию, двигающую окно). */
  setRelayout(fn: () => void): void {
    this.onRelayout = fn;
  }

  setTarget(t: MonitorTarget): void {
    this.target = t;
    log.info("цель монитора", { target: t });
    this.onRelayout?.(); // «выведи на основной/верни на свой» — двигаем окно сразу
  }

  get currentTarget(): MonitorTarget {
    return this.target;
  }

  /** Настроить, какой монитор — «Джарвиса» (persist). null = авто (вторичный). */
  setJarvisIndex(i: number | null): void {
    this.cfg.jarvisIndex = i;
    this.save();
    log.info("монитор Джарвиса настроен", { jarvisIndex: i });
    if (this.target === "jarvis") this.onRelayout?.(); // сменили рабочий экран — переедем туда
  }

  /**
   * Куда поставить ОКНО Джарвиса (его компактный UI, не полноэкранное приложение): верхний правый
   * угол рабочей области целевого монитора, с отступом, сохраняя размеры окна (winW×winH).
   */
  windowPosition(winW: number, winH: number): { x: number; y: number } {
    const wa = this.targetDisplay().workArea;
    return {
      x: Math.round(wa.x + Math.max(0, wa.width - winW - 24)),
      y: Math.round(wa.y + 48),
    };
  }

  /** Текущий настроенный индекс рабочего монитора Джарвиса (null = авто/вторичный). */
  get jarvisIndex(): number | null {
    return this.cfg.jarvisIndex;
  }

  /** Перечислить мониторы с человеко-метками — для UI и автономного выбора (§6). */
  monitorList(): MonitorList {
    const all = this.displays();
    const primary = screen.getPrimaryDisplay();
    const jarvis = this.jarvisDisplay();
    const monitors: MonitorInfo[] = all.map((d, index) => ({
      index,
      label: this.labelFor(d, index, primary),
      width: d.size.width,
      height: d.size.height,
      isPrimary: d.id === primary.id,
      isJarvis: d.id === jarvis.id,
    }));
    return { monitors, jarvisIndex: this.cfg.jarvisIndex };
  }

  /** Человеко-метка монитора: «Монитор 2 — 2560×1440 (справа)». */
  private labelFor(d: Display, index: number, primary: Display): string {
    const res = `${d.size.width}×${d.size.height}`;
    const tags: string[] = [];
    if (d.id === primary.id) tags.push("основной");
    else if (d.bounds.x < primary.bounds.x) tags.push("слева");
    else if (d.bounds.x > primary.bounds.x) tags.push("справа");
    else if (d.bounds.y < primary.bounds.y) tags.push("сверху");
    else if (d.bounds.y > primary.bounds.y) tags.push("снизу");
    return `Монитор ${index + 1} — ${res}${tags.length ? ` (${tags.join(", ")})` : ""}`;
  }

  /** Сводка для логов/диагностики. */
  summary(): string {
    const all = this.displays();
    const primary = screen.getPrimaryDisplay();
    const j = this.jarvisDisplay();
    return `мониторов: ${all.length}; Джарвис на ${j.id === primary.id ? "основном" : "вторичном"}; цель: ${this.target}`;
  }

  private load(): void {
    this.loaded = true;
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
