/**
 * Управление положением окна: свернуть / развернуть / восстановить / ПЕРЕНЕСТИ НА МОНИТОР.
 *
 * 🔴 ЗАЧЕМ (самопроверка Джарвиса 2026-09-01, пункты 3-4 его же списка нехваток): «умею смотреть,
 * на каком мониторе окно, но не умею его туда ПЕРЕместить — „открой на втором" приходится
 * выполнять наугад» и «управление окнами: свернуть/развернуть — нет ни одного инструмента».
 * Живой провал того же дня: владелец попросил открыть Telegram на втором мониторе — Джарвис
 * открыл где открылось. Смотреть умели (window_list.monitorIndex), двигать — нет.
 *
 * МЕХАНИЗМ: user32 через PowerShell (тот же приём, что в system.ts) — ShowWindow для состояния,
 * SetWindowPos для переноса. Координаты монитора берём из Electron (`screen`), потому что индексы
 * мониторов ОБЯЗАНЫ совпадать с window_list/screen_capture — иначе «перенеси на второй» и
 * «сними второй» означали бы разные экраны. workArea (не bounds) — чтобы окно не залезало под
 * панель задач; DIP→физические пиксели переводит `screen.dipToScreenRect` (mixed-DPI мультимонитор
 * — известная грабля проекта: наивное умножение на scaleFactor врёт при разных масштабах).
 *
 * ЧЕСТНОСТЬ: после операции окно ПЕРЕЧИТЫВАЕТСЯ (GetWindowRect + IsIconic/IsZoomed) и результат
 * несёт фактическое состояние. Перенос, который не состоялся (окно осталось на прежнем мониторе),
 * возвращает ошибку — «ok» от SetWindowPos само по себе ничего не доказывает.
 */
import { spawn } from "node:child_process";
import { screen } from "electron";
import { createLogger } from "@jarvis/shared";
import { monitors } from "../monitors.js";

const log = createLogger("actuator:window-arrange");

export type ArrangeOp = "minimize" | "maximize" | "restore" | "move";

export interface ArrangeResult {
  hwnd: number;
  /** Состояние ПОСЛЕ операции, перечитанное из ОС. */
  minimized: boolean;
  maximized: boolean;
  rect: { x: number; y: number; w: number; h: number };
  /** На каком мониторе окно оказалось (индекс согласован с window_list/screen_capture). */
  monitorIndex: number | null;
  monitor: string;
}

const TIMEOUT_MS = 15_000;

/** user32-скрипт: применяет операцию и печатает перечитанное состояние строкой с табами. */
const PS = [
  "$ErrorActionPreference='Stop'",
  "$sig = @'",
  '[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);',
  '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);',
  '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
  '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);',
  '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  "public struct RECT { public int Left, Top, Right, Bottom; }",
  "'@",
  // ⚠️ ГРАБЛЯ: -PassThru возвращает МАССИВ типов (класс + объявленная тут же структура RECT),
  // и `$u::IsWindow(...)` падает «метод не найден у System.Object[]». Берём именно класс.
  "$u = (Add-Type -MemberDefinition $sig -Name WinArrange -Namespace JarvisWin -PassThru) | Where-Object { $_.Name -eq 'WinArrange' }",
  "$h = [IntPtr][int64]$env:JARVIS_WIN_HWND",
  "if (-not $u::IsWindow($h)) { Write-Error 'no-window'; exit 3 }",
  "$op = $env:JARVIS_WIN_OP",
  "if ($op -eq 'minimize') { [void]$u::ShowWindow($h, 6) }",
  "elseif ($op -eq 'maximize') { [void]$u::ShowWindow($h, 3) }",
  "elseif ($op -eq 'restore') { [void]$u::ShowWindow($h, 9) }",
  "elseif ($op -eq 'move') {",
  // Развёрнутое/свёрнутое окно SetWindowPos визуально игнорирует — сперва восстанавливаем.
  "  if ($u::IsZoomed($h) -or $u::IsIconic($h)) { [void]$u::ShowWindow($h, 9); Start-Sleep -Milliseconds 120 }",
  "  $x = [int]$env:JARVIS_WIN_X; $y = [int]$env:JARVIS_WIN_Y",
  "  $w = [int]$env:JARVIS_WIN_W; $hh = [int]$env:JARVIS_WIN_H",
  "  [void]$u::SetWindowPos($h, [IntPtr]::Zero, $x, $y, $w, $hh, 0x14)",
  "  if ($env:JARVIS_WIN_THEN_MAX -eq '1') { Start-Sleep -Milliseconds 120; [void]$u::ShowWindow($h, 3) }",
  "}",
  "Start-Sleep -Milliseconds 150",
  "$r = New-Object JarvisWin.WinArrange+RECT",
  "[void]$u::GetWindowRect($h, [ref]$r)",
  "$mini = $u::IsIconic($h); $maxi = $u::IsZoomed($h)",
  "[Console]::Out.Write(('{0}\t{1}\t{2}\t{3}\t{4}\t{5}' -f $r.Left, $r.Top, ($r.Right-$r.Left), ($r.Bottom-$r.Top), [int][bool]$mini, [int][bool]$maxi))",
].join("\n");

function run(env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS], {
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      ps.kill();
      reject(new Error("операция с окном не ответила вовремя"));
    }, TIMEOUT_MS);
    ps.stdout.on("data", (d) => (out += String(d)));
    ps.stderr.on("data", (d) => (err += String(d)));
    ps.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ps.on("close", (code) => {
      clearTimeout(timer);
      if (code === 3) reject(new Error("окно не существует (hwnd устарел) — перечитай window_list"));
      else if (code !== 0) reject(new Error(err.trim().split("\n")[0] || `powershell завершился с кодом ${code}`));
      else resolve(out);
    });
  });
}

/** Разбор перечитанного состояния. ЧИСТАЯ функция. */
export function parseArrange(raw: string): { rect: { x: number; y: number; w: number; h: number }; minimized: boolean; maximized: boolean } {
  const f = raw.trim().split("\t");
  if (f.length < 6) throw new Error(`не разобрал состояние окна: ${raw.slice(0, 120)}`);
  const n = (i: number) => Number.parseInt(f[i] ?? "", 10) || 0;
  return {
    rect: { x: n(0), y: n(1), w: n(2), h: n(3) },
    minimized: f[4] === "1",
    maximized: f[5] === "1",
  };
}

/**
 * Куда ставить окно на мониторе `index`: рабочая область в ФИЗИЧЕСКИХ пикселях.
 * Индексация — та же, что у window_list/screen_capture (screen.getAllDisplays()).
 */
export function targetRectFor(index: number): { x: number; y: number; w: number; h: number } {
  const all = screen.getAllDisplays();
  const d = all[index];
  if (!d) throw new Error(`монитора с индексом ${index} нет (всего ${all.length}) — посмотри monitor_list`);
  const phys = screen.dipToScreenRect(null, d.workArea);
  return { x: phys.x, y: phys.y, w: phys.width, h: phys.height };
}

/**
 * Применить операцию к окну. Для `move` окно СОХРАНЯЕТ размер (вписываясь в рабочую область
 * целевого монитора), а не растягивается: «перенеси на второй» — про положение, не про размер.
 */
export async function arrangeWindow(opts: {
  hwnd: number;
  op: ArrangeOp;
  monitor?: number;
  /** Текущий rect окна (из window_list) — чтобы сохранить размер при переносе. */
  current?: { x: number; y: number; w: number; h: number };
  /** Развернуть на весь целевой монитор после переноса. */
  maximizeAfterMove?: boolean;
}): Promise<ArrangeResult> {
  const env: Record<string, string> = {
    JARVIS_WIN_HWND: String(opts.hwnd),
    JARVIS_WIN_OP: opts.op,
    JARVIS_WIN_THEN_MAX: opts.maximizeAfterMove ? "1" : "0",
  };
  if (opts.op === "move") {
    if (opts.monitor === undefined) throw new Error("для переноса нужен индекс монитора (monitor)");
    const t = targetRectFor(opts.monitor);
    // Сохраняем размер окна, но не даём ему вылезти за рабочую область целевого монитора.
    const w = Math.min(opts.current?.w || Math.round(t.w * 0.7), t.w);
    const h = Math.min(opts.current?.h || Math.round(t.h * 0.7), t.h);
    env.JARVIS_WIN_X = String(t.x + Math.max(0, Math.round((t.w - w) / 2)));
    env.JARVIS_WIN_Y = String(t.y + Math.max(0, Math.round((t.h - h) / 2)));
    env.JARVIS_WIN_W = String(w);
    env.JARVIS_WIN_H = String(h);
  }
  const st = parseArrange(await run(env));
  let monitorIndex: number | null = null;
  let monitor = "неизвестно";
  if (!st.minimized && st.rect.w > 0 && st.rect.x > -30000) {
    try {
      const m = monitors.displayForRect({ x: st.rect.x, y: st.rect.y, width: st.rect.w, height: st.rect.h });
      monitorIndex = m.index;
      monitor = m.primary ? "осн. монитор" : `монитор ${m.index + 1}`;
    } catch {
      /* монитор не определился — честно оставляем «неизвестно» */
    }
  } else if (st.minimized) {
    monitor = "свёрнуто";
  }
  // ЧЕСТНАЯ СВЕРКА: перенос обязан ПРИВЕСТИ окно на запрошенный монитор, иначе это провал.
  if (opts.op === "move" && opts.monitor !== undefined && monitorIndex !== opts.monitor) {
    throw new Error(
      `окно не переехало на монитор ${opts.monitor + 1} (сейчас: ${monitor}) — возможно, оно закреплено приложением`,
    );
  }
  const res: ArrangeResult = { hwnd: opts.hwnd, ...st, monitorIndex, monitor };
  log.info("окно переставлено", { op: opts.op, ...res });
  return res;
}
