/**
 * Живой системный снимок (§ контекст системы): какие окна СЕЙЧАС открыты, на каком мониторе,
 * что на переднем плане. Уходит агенту периодически (client.system) → некешируемый хвост промпта,
 * чтобы Джарвис КАЖДЫЙ ХОД знал, что запущено и где — без tool-call и без round-trip.
 *
 * Источник окон — PowerShell + Win32 EnumWindows (без нативных модулей). Привязку окно→монитор
 * делаем в клиенте через monitors.displayForRect (индекс СОГЛАСОВАН с screen_capture). Это фикс
 * «two-monitor слепоты»: раньше Джарвис видел только монитор под курсором и ложно решал «не запущено».
 */
import { createLogger } from "@jarvis/shared";
import { monitors } from "../monitors.js";
import { runPsJson } from "./system-profiler.js";

const log = createLogger("sensors:snapshot");

/** Сырое окно от PowerShell (rect — ФИЗИЧЕСКИЕ пиксели Win32). */
interface RawWindow {
  proc: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fg: boolean;
  min: boolean;
}

/** Окно с привязкой к монитору Electron. */
export interface WindowSnap {
  process: string;
  title: string;
  monitorIndex: number;
  monitorLabel: string;
  primary: boolean;
  jarvis: boolean;
  foreground: boolean;
  minimized: boolean;
}

// EnumWindows через Add-Type user32: видимые верхнеуровневые окна с заголовком (без tool-window'ов).
// Unicode GetWindowTextW (иначе кириллица в «?»). $procId — НЕ $pid (зарезервирована в PowerShell).
const WINDOWS_PS = `Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class JWin{
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb,IntPtr p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int i);
 public delegate bool EnumWindowsProc(IntPtr h,IntPtr p);
 [StructLayout(LayoutKind.Sequential)] public struct RECT{public int L,T,R,B;}
}
"@
$fg=[JWin]::GetForegroundWindow()
$res=New-Object System.Collections.ArrayList
$cb=[JWin+EnumWindowsProc]{ param($h,$p)
 if(-not [JWin]::IsWindowVisible($h)){return $true}
 if(([JWin]::GetWindowLong($h,-20) -band 0x80) -ne 0){return $true}
 $len=[JWin]::GetWindowTextLength($h); if($len -le 1){return $true}
 $sb=New-Object System.Text.StringBuilder ($len+2); [void][JWin]::GetWindowTextW($h,$sb,$sb.Capacity)
 $title=$sb.ToString()
 $procId=0; [void][JWin]::GetWindowThreadProcessId($h,[ref]$procId)
 if($procId -eq 0){return $true}
 $r=New-Object 'JWin+RECT'; [void][JWin]::GetWindowRect($h,[ref]$r)
 $pname=try{(Get-Process -Id $procId -ErrorAction Stop).ProcessName}catch{'?'}
 [void]$res.Add([pscustomobject]@{proc=$pname;title=$title;x=$r.L;y=$r.T;w=($r.R-$r.L);h=($r.B-$r.T);fg=($h -eq $fg);min=[JWin]::IsIconic($h)})
 return $true
}
[void][JWin]::EnumWindows($cb,[IntPtr]::Zero)
ConvertTo-Json -Compress -Depth 3 -InputObject @($res)`;

/** Окна Джарвиса/служебный мусор — не показываем агенту (саморефлексия/шум). */
function isNoise(proc: string, title: string): boolean {
  const p = proc.toLowerCase();
  if (/electron|jarvis|sidecarwin/.test(p)) return true;
  if (/^(program manager|настройка|default ime|windows input experience)$/i.test(title.trim())) return true;
  return false;
}

/** Снять окна и привязать к мониторам Electron (индексы как у screen_capture). */
export async function enumWindows(): Promise<WindowSnap[]> {
  const raw = await runPsJson<RawWindow[]>(WINDOWS_PS, 8000);
  if (!Array.isArray(raw)) return [];
  const out: WindowSnap[] = [];
  for (const w of raw) {
    const proc = String(w.proc ?? "").trim();
    const title = String(w.title ?? "").trim();
    if (!proc || isNoise(proc, title)) continue;
    const m = monitors.displayForRect({ x: w.x, y: w.y, width: w.w, height: w.h });
    out.push({
      process: proc,
      title,
      monitorIndex: m.index,
      monitorLabel: m.label,
      primary: m.primary,
      jarvis: m.jarvis,
      foreground: Boolean(w.fg),
      minimized: Boolean(w.min),
    });
  }
  return out;
}

/** Короткое имя монитора для сводки: «осн.»/«M2» по индексу. */
function shortMon(w: WindowSnap): string {
  return w.primary ? "осн. монитор" : `монитор ${w.monitorIndex + 1}`;
}

/**
 * §sec (M11) ГРАНИЦА ДАННЫЕ/ИНСТРУКЦИИ: заголовок окна — текст, который может задать ЛЮБОЙ сторонний
 * сайт/приложение (вкладка браузера, документ) — это НЕДОВЕРЕННЫЕ данные, а не команды владельца.
 * Здесь заголовки идут СЫРЫМИ; формальный маркер `<untrusted_content>` навешивает СЕРВЕР при сборке
 * системного промпта (persona/index.ts, тем же тегом, что web_search/browser_read) — так модель
 * распознаёт границу тем же обученным механизмом, а не самодельной текстовой пометкой на клиенте.
 */

/** Компактная live-сводка для промпта (чистая — для теста). Заголовки — сырые (untrusted-обёртка на сервере). */
export function formatAmbient(wins: readonly WindowSnap[], monitorCount: number): string {
  if (wins.length === 0) return monitorCount > 1 ? `Мониторов: ${monitorCount}.` : "";
  const cut = (s: string): string => (s.length > 50 ? `${s.slice(0, 49)}…` : s);
  const parts: string[] = [];
  const fg = wins.find((w) => w.foreground);
  if (fg) parts.push(`На переднем плане: ${fg.process}${fg.title ? ` ${cut(fg.title)}` : ""} — ${shortMon(fg)}`);
  // Остальные окна — по процессу, с монитором; свёрнутые помечаем.
  const others = wins.filter((w) => w !== fg).slice(0, 10);
  if (others.length) {
    const items = others.map((w) => `${w.process} (${shortMon(w)}${w.minimized ? ", свёрнуто" : ""})`);
    parts.push(`Открыто: ${items.join(", ")}`);
  }
  if (monitorCount > 1) parts.push(`мониторов: ${monitorCount}`);
  return `${parts.join(". ")}.`;
}

// ── ОТКУДА ИДЁТ ЗВУК (§контекст системы): WASAPI per-session peak — какое ПРИЛОЖЕНИЕ реально звучит
// СЕЙЧАС, на системном уровне, без скриншота. Джарвис должен сам знать источник звука («эту музыку»,
// «это видео») без уточнений. C# перечисляет аудио-сессии устройства вывода, сэмплит пик ~0.4с (у музыки
// есть тихие моменты) и отдаёт «процесс|пик;…»; PowerShell → JSON; играющими считаем пик > порога.
const AUDIO_PS = `$src = @'
using System;using System.Runtime.InteropServices;using System.Text;using System.Collections.Generic;using System.Threading;
public class JAud{
 [DllImport("ole32.dll")] static extern int CoCreateInstance(ref Guid c,IntPtr o,int x,ref Guid i,out IntPtr p);
 [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDE{int EnumAudioEndpoints(int f,int s,out IntPtr e);int GetDefaultAudioEndpoint(int f,int r,out IntPtr d);}
 [Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMD{int Activate(ref Guid id,int ctx,IntPtr p,[MarshalAs(UnmanagedType.IUnknown)]out object o);}
 [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IASM2{int f3();int f4();int GetSessionEnumerator(out IntPtr e);}
 [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IASE{int GetCount(out int c);int GetSession(int i,out IntPtr s);}
 [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IASC2{int GetState(out int s);int f4();int f5();int f6();int f7();int f8();int f9();int f10();int f11();int gsi(out IntPtr p);int gsii(out IntPtr p);int GetProcessId(out uint pid);}
 [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAMI{int GetPeakValue(out float v);}
 public static string Probe(){
  var clsid=new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"); var iid=new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"); IntPtr ep;
  CoCreateInstance(ref clsid,IntPtr.Zero,1,ref iid,out ep); var de=(IMMDE)Marshal.GetObjectForIUnknown(ep);
  IntPtr dev; de.GetDefaultAudioEndpoint(0,0,out dev); var d=(IMMD)Marshal.GetObjectForIUnknown(dev);
  var gMgr=new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"); object mo; d.Activate(ref gMgr,1,IntPtr.Zero,out mo);
  var mgr=(IASM2)mo; IntPtr enp; mgr.GetSessionEnumerator(out enp); var en=(IASE)Marshal.GetObjectForIUnknown(enp);
  int n; en.GetCount(out n); var meters=new List<IAMI>(); var names=new List<string>(); var peak=new List<float>();
  for(int i=0;i<n;i++){ IntPtr sp; en.GetSession(i,out sp); var c2=(IASC2)Marshal.GetObjectForIUnknown(sp); var m=(IAMI)Marshal.GetObjectForIUnknown(sp);
   uint pid; c2.GetProcessId(out pid); string nm="?"; try{ nm=System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }catch{}
   meters.Add(m); names.Add(nm); peak.Add(0f); }
  for(int s=0;s<8;s++){ for(int i=0;i<meters.Count;i++){ float v; meters[i].GetPeakValue(out v); if(v>peak[i])peak[i]=v; } Thread.Sleep(45); }
  var sb=new StringBuilder();
  for(int i=0;i<names.Count;i++){ var nm=names[i].ToLower(); if(nm=="idle"||nm=="electron"||nm=="?"||nm=="audiodg")continue;
   sb.Append(names[i]+"|"+peak[i].ToString("0.000",System.Globalization.CultureInfo.InvariantCulture)+";"); }
  return sb.ToString();
 }
}
'@
Add-Type -TypeDefinition $src -ErrorAction Stop
$raw=[JAud]::Probe()
$items=$raw.TrimEnd(';').Split(';') | Where-Object { $_ } | ForEach-Object { $p=$_.Split('|'); [pscustomobject]@{ name=$p[0]; peak=[double]$p[1] } }
ConvertTo-Json -Compress -Depth 3 -InputObject @($items)`;

/** Дружественное имя процесса для озвучки источника звука. */
function audioFriendly(proc: string): string {
  const p = proc.toLowerCase();
  const map: Record<string, string> = {
    chrome: "браузер (хром)", msedge: "браузер (Edge)", firefox: "браузер (Firefox)", opera: "браузер (Opera)",
    yandex: "браузер (Яндекс)", browser: "браузер",
    spotify: "Spotify", "яндекс.музыка": "Яндекс Музыка", music: "музыка",
    dota2: "Dota 2", telegram: "Telegram", discord: "Discord", vlc: "VLC", obs64: "OBS", steam: "Steam",
  };
  return map[p] ?? proc;
}

/** «Звук идёт из: …» — какие приложения реально звучат сейчас (пик выше порога). Пусто → "". */
export async function captureAudioSources(): Promise<string> {
  try {
    const items = await runPsJson<Array<{ name: string; peak: number }>>(AUDIO_PS, 8000);
    if (!Array.isArray(items)) return "";
    const playing = items
      .filter((s) => Number(s.peak) > 0.01)
      .sort((a, b) => Number(b.peak) - Number(a.peak))
      .slice(0, 3)
      .map((s) => audioFriendly(String(s.name ?? "").trim()))
      .filter(Boolean);
    return playing.length ? `Звук идёт из: ${[...new Set(playing)].join(", ")}` : "";
  } catch (e) {
    log.warn("источник звука не собран", e instanceof Error ? e.message : String(e));
    return "";
  }
}

/** Полный цикл: окна + источник звука → строка для агента. Ошибка/пусто → пустая (мягкая деградация). */
export async function captureAmbient(): Promise<string> {
  try {
    const [windowsLine, audioLine] = await Promise.all([
      enumWindows().then((wins) => formatAmbient(wins, monitors.displays().length)),
      captureAudioSources(),
    ]);
    return [windowsLine, audioLine].filter((s) => s && s.trim()).join(" ");
  } catch (e) {
    log.warn("снимок окон не собран", e instanceof Error ? e.message : String(e));
    return "";
  }
}
