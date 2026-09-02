/**
 * Пер-процессный звук (Core Audio / WASAPI session API): КТО звучит и как это заглушить.
 *
 * 🔴 ЗАЧЕМ (живой провал 2026-09-01): владелец сказал «у меня появился какой-то звук с видоса,
 * выруби это нахуй» — и Джарвис не смог. У него была только ОБЩАЯ громкость (`system.volume`)
 * и медиа-клавиши, которые уходят активному плееру, а не источнику. Он честно доложил «тишина,
 * peak 0» (мерил ОБЩИЙ выход) и не заглушил ничего; владелец выключил звук сам. Здесь закрыт
 * ровно этот разрыв: список сессий вывода с процессом и пиком + точечный мьют по pid/процессу.
 *
 * МЕХАНИЗМ. Тот же приём, что уже отработан в `system.ts` для IAudioEndpointVolume: инлайн-C#
 * через `Add-Type` в PowerShell, COM-интерфейсы объявлены руками. Цепочка:
 * IMMDeviceEnumerator → GetDefaultAudioEndpoint(eRender, eMultimedia) → Activate(IAudioSessionManager2)
 * → GetSessionEnumerator → IAudioSessionControl2 (pid, состояние, системные звуки) →
 * приведение к ISimpleAudioVolume (мьют/громкость) и IAudioMeterInformation (пик).
 *
 * ⚠️ ГРАБЛЯ, стоившая ложных данных при отладке: `IsSystemSoundsSession()` — единственный метод
 * без out-параметра, и без явного `[PreserveSig]` рантайм трактует HRESULT как возвращаемое
 * значение → S_OK(0) читался как «да, системные звуки» для ЛЮБОЙ сессии, и chrome/electron
 * назывались «SystemSounds». Атрибут обязателен. Остальные методы отдают HRESULT штатно.
 *
 * ⚠️ ВТОРАЯ ГРАБЛЯ: `$Pid` в PowerShell — встроенная переменная только для чтения (PID самого
 * процесса), параметр так назвать нельзя — скрипт падает ещё до работы. Цель передаём через ENV.
 *
 * ⚠️ ФОРМАТ ОБМЕНА — СТРОКИ С ТАБАМИ, не JSON: JSON пришлось бы экранировать трижды (C# внутри
 * PowerShell внутри шаблонной строки TS), и это ломкая конструкция. Табы и переводы строк из
 * имён вырезаются на стороне C#, поэтому экранировать нечего вовсе.
 *
 * ЧЕСТНОСТЬ: `audio.set` возвращает состояние, ПЕРЕЧИТАННОЕ после записи, и `touched` — сколько
 * сессий реально задето. Ни одной подходящей сессии (приложение молчит или уже закрыто) →
 * ошибка «глушить нечего», а НЕ «готово»: это провал задачи, а не успех.
 */
import { spawn } from "node:child_process";
import { createLogger } from "@jarvis/shared";

const log = createLogger("actuator:audio-sessions");

/** Сессия вывода звука. */
export interface AudioSession {
  pid: number;
  process: string;
  /** Имя сессии от приложения (часто пустое — тогда ориентируемся на process). */
  title: string;
  state: "active" | "inactive";
  muted: boolean;
  /** 0..1 — громкость ПРИЛОЖЕНИЯ (не общая). */
  volume: number;
  /** 0..1 — мгновенный пик. >0 = прямо сейчас звучит. */
  peak: number;
}

/** Потолок ожидания PowerShell: COM-опрос быстрый, но первый Add-Type компилирует C#. */
const TIMEOUT_MS = 20_000;

/** Разделитель полей: в именах процессов и заголовках его быть не может (вырезаем в C#). */
const SEP = "\t";

/**
 * Инлайн-C# для Add-Type. Строка ФИКСИРОВАННАЯ — пользовательский ввод сюда не попадает
 * (цель передаётся через переменные окружения), как и во всех остальных PS-актуаторах проекта.
 * Вывод: по строке на сессию, поля через таб. Первая строка Apply — счётчик задетых.
 */
const CSHARP = [
  "using System;",
  "using System.Text;",
  "using System.Runtime.InteropServices;",
  "namespace JarvisAudio {",
  '  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumerator { }',
  '  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  "  public interface IMMDeviceEnumerator {",
  "    int EnumAudioEndpoints(int f, int m, out IntPtr c);",
  "    int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev);",
  "  }",
  '  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  "  public interface IMMDevice {",
  "    int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);",
  "  }",
  '  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  "  public interface IAudioSessionManager2 {",
  "    int GetAudioSessionControl(IntPtr g, int s, out IntPtr c);",
  "    int GetSimpleAudioVolume(IntPtr g, int s, out IntPtr v);",
  "    int GetSessionEnumerator(out IAudioSessionEnumerator e);",
  "  }",
  '  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  "  public interface IAudioSessionEnumerator {",
  "    int GetCount(out int count);",
  "    int GetSession(int i, out IAudioSessionControl2 s);",
  "  }",
  '  [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  "  public interface IAudioSessionControl2 {",
  "    int GetState(out int state);",
  "    int GetDisplayName(out IntPtr name);",
  "    int SetDisplayName(string n, ref Guid g);",
  "    int GetIconPath(out IntPtr p);",
  "    int SetIconPath(string p, ref Guid g);",
  "    int GetGroupingParam(out Guid g);",
  "    int SetGroupingParam(ref Guid g, ref Guid ctx);",
  "    int RegisterAudioSessionNotification(IntPtr n);",
  "    int UnregisterAudioSessionNotification(IntPtr n);",
  "    int GetSessionIdentifier(out IntPtr id);",
  "    int GetSessionInstanceIdentifier(out IntPtr id);",
  "    int GetProcessId(out uint pid);",
  "    [PreserveSig] int IsSystemSoundsSession();",
  "    int SetDuckingPreference(bool opt);",
  "  }",
  '  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  "  public interface ISimpleAudioVolume {",
  "    int SetMasterVolume(float v, ref Guid g);",
  "    int GetMasterVolume(out float v);",
  "    int SetMute(bool m, ref Guid g);",
  "    int GetMute(out bool m);",
  "  }",
  '  [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  "  public interface IAudioMeterInformation { int GetPeakValue(out float peak); }",
  "  public static class Sessions {",
  '    static Guid IID_ASM2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");',
  "    static Guid EMPTY = Guid.Empty;",
  "    static System.Globalization.CultureInfo INV = System.Globalization.CultureInfo.InvariantCulture;",
  "    static IAudioSessionEnumerator Enumerator() {",
  "      IMMDevice dev; object o;",
  "      ((IMMDeviceEnumerator)(new MMDeviceEnumerator())).GetDefaultAudioEndpoint(0, 1, out dev);",
  "      dev.Activate(ref IID_ASM2, 1, IntPtr.Zero, out o);",
  "      IAudioSessionEnumerator e; ((IAudioSessionManager2)o).GetSessionEnumerator(out e); return e;",
  "    }",
  "    static string ProcName(uint pid) {",
  '      try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }',
  "    }",
  "    static string Clean(string s) {",
  '      if (s == null) return "";',
  "      var b = new StringBuilder();",
  "      foreach (char c in s) { if (c != '\\t' && c != '\\r' && c != '\\n') b.Append(c); }",
  "      return b.ToString();",
  "    }",
  "    public static string List() {",
  "      var e = Enumerator(); int n; e.GetCount(out n);",
  "      var sb = new StringBuilder();",
  "      for (int i = 0; i < n; i++) {",
  "        IAudioSessionControl2 s;",
  "        if (e.GetSession(i, out s) != 0 || s == null) continue;",
  "        int st; s.GetState(out st);",
  "        if (st == 2) continue;",
  "        uint pid; s.GetProcessId(out pid);",
  "        bool sys = (s.IsSystemSoundsSession() == 0);",
  "        var sv = (ISimpleAudioVolume)s; var mi = (IAudioMeterInformation)s;",
  "        bool mute; sv.GetMute(out mute);",
  "        float vol; sv.GetMasterVolume(out vol);",
  "        float peak; mi.GetPeakValue(out peak);",
  '        string name = sys ? "SystemSounds" : ProcName(pid);',
  '        IntPtr dn; string disp = "";',
  "        if (s.GetDisplayName(out dn) == 0 && dn != IntPtr.Zero) { disp = Marshal.PtrToStringUni(dn); Marshal.FreeCoTaskMem(dn); }",
  "        sb.Append(pid).Append('\\t').Append(Clean(name)).Append('\\t')",
  "          .Append(st == 1 ? 1 : 0).Append('\\t').Append(mute ? 1 : 0).Append('\\t')",
  '          .Append(vol.ToString("0.###", INV)).Append(\'\\t\').Append(peak.ToString("0.####", INV))',
  "          .Append('\\t').Append(Clean(disp)).Append('\\n');",
  "      }",
  "      return sb.ToString();",
  "    }",
  "    public static string Apply(int pid, string procName, int mute, double level) {",
  "      var e = Enumerator(); int n; e.GetCount(out n);",
  "      var sb = new StringBuilder(); int touched = 0;",
  "      for (int i = 0; i < n; i++) {",
  "        IAudioSessionControl2 s;",
  "        if (e.GetSession(i, out s) != 0 || s == null) continue;",
  "        int st; s.GetState(out st);",
  "        if (st == 2) continue;",
  "        uint spid; s.GetProcessId(out spid);",
  "        bool sys = (s.IsSystemSoundsSession() == 0);",
  '        string name = sys ? "SystemSounds" : ProcName(spid);',
  "        bool match = (pid > 0 && spid == (uint)pid)",
  "          || (!string.IsNullOrEmpty(procName) && name.Equals(procName, StringComparison.OrdinalIgnoreCase));",
  "        if (!match) continue;",
  "        var sv = (ISimpleAudioVolume)s;",
  "        if (mute >= 0) sv.SetMute(mute == 1, ref EMPTY);",
  "        if (level >= 0) sv.SetMasterVolume((float)Math.Min(1.0, level), ref EMPTY);",
  "        bool m2; sv.GetMute(out m2);",
  "        float v2; sv.GetMasterVolume(out v2);",
  "        touched++;",
  "        sb.Append(spid).Append('\\t').Append(Clean(name)).Append('\\t')",
  '          .Append(m2 ? 1 : 0).Append(\'\\t\').Append(v2.ToString("0.###", INV)).Append(\'\\n\');',
  "      }",
  '      return touched + "\\n" + sb.ToString();',
  "    }",
  "  }",
  "}",
].join("\n");

/** PowerShell-обёртка: только вызов статики, вся логика в C#. */
function script(): string {
  return [
    "$ErrorActionPreference='Stop'",
    "$src = @'",
    CSHARP,
    "'@",
    "Add-Type -TypeDefinition $src | Out-Null",
    "if ($env:JARVIS_AUDIO_OP -eq 'list') { [Console]::Out.Write([JarvisAudio.Sessions]::List()) } else {",
    "  $m = -1",
    "  if ($env:JARVIS_AUDIO_MUTE -eq 'on') { $m = 1 } elseif ($env:JARVIS_AUDIO_MUTE -eq 'off') { $m = 0 }",
    "  $lv = -1.0",
    "  if ($env:JARVIS_AUDIO_LEVEL) { $lv = [double]$env:JARVIS_AUDIO_LEVEL }",
    "  [Console]::Out.Write([JarvisAudio.Sessions]::Apply([int]$env:JARVIS_AUDIO_PID, $env:JARVIS_AUDIO_PROCESS, $m, $lv))",
    "}",
  ].join("\n");
}

/** Запустить PS. Цель идёт ЧЕРЕЗ ENV — не через командную строку (анти-инъекция, как в system.ts). */
function run(env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script()],
      { windowsHide: true, env: { ...process.env, ...env } },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      ps.kill();
      reject(new Error("опрос звуковых сессий не ответил вовремя"));
    }, TIMEOUT_MS);
    ps.stdout.on("data", (d) => (out += String(d)));
    ps.stderr.on("data", (d) => (err += String(d)));
    ps.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ps.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(err.trim().split("\n")[0] || `powershell завершился с кодом ${code}`));
      else resolve(out);
    });
  });
}

/**
 * Разбор строк вывода. ЧИСТАЯ функция — тестируется без PowerShell.
 * Строка: pid \t process \t state(0/1) \t muted(0/1) \t volume \t peak \t title
 */
export function parseSessions(raw: string): AudioSession[] {
  const list: AudioSession[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const f = line.split(SEP);
    if (f.length < 6) continue;
    const pid = Number.parseInt(f[0] ?? "", 10);
    if (!Number.isFinite(pid)) continue;
    list.push({
      pid,
      process: f[1] ?? "",
      state: f[2] === "1" ? "active" : "inactive",
      muted: f[3] === "1",
      volume: Number.parseFloat(f[4] ?? "0") || 0,
      peak: Number.parseFloat(f[5] ?? "0") || 0,
      title: (f[6] ?? "").trim(),
    });
  }
  // Сперва то, что РЕАЛЬНО звучит (пик), потом активные — «что это за звук» отвечается первой строкой.
  return list.sort((a, b) => b.peak - a.peak || Number(b.state === "active") - Number(a.state === "active"));
}

export interface AudioSetResult {
  touched: number;
  sessions: Array<{ pid: number; process: string; muted: boolean; volume: number }>;
}

/** Разбор результата записи. ЧИСТАЯ функция. Первая строка — счётчик задетых сессий. */
export function parseApplied(raw: string): AudioSetResult {
  const lines = raw.split("\n");
  const touched = Number.parseInt(lines[0] ?? "", 10);
  const sessions: AudioSetResult["sessions"] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const f = line.split(SEP);
    if (f.length < 4) continue;
    const pid = Number.parseInt(f[0] ?? "", 10);
    if (!Number.isFinite(pid)) continue;
    sessions.push({
      pid,
      process: f[1] ?? "",
      muted: f[2] === "1",
      volume: Number.parseFloat(f[3] ?? "0") || 0,
    });
  }
  return { touched: Number.isFinite(touched) ? touched : sessions.length, sessions };
}

/** Кто сейчас звучит. */
export async function listAudioSessions(): Promise<AudioSession[]> {
  return parseSessions(await run({ JARVIS_AUDIO_OP: "list" }));
}

/**
 * Применить мьют/громкость к сессиям приложения.
 * Ни одной подходящей сессии → ОШИБКА (заглушать нечего = задача не выполнена, не «готово»).
 */
export async function setAudioSession(opts: {
  pid?: number;
  process?: string;
  mute?: boolean;
  level?: number;
}): Promise<AudioSetResult> {
  const proc = (opts.process ?? "").trim().replace(/\.exe$/i, "");
  if (!opts.pid && !proc) throw new Error("не указано, какому приложению менять звук (pid или process)");
  if (opts.mute === undefined && opts.level === undefined) throw new Error("не указано, что менять: mute или level");
  const res = parseApplied(
    await run({
      JARVIS_AUDIO_OP: "apply",
      JARVIS_AUDIO_PID: String(opts.pid ?? 0),
      JARVIS_AUDIO_PROCESS: proc,
      JARVIS_AUDIO_MUTE: opts.mute === undefined ? "" : opts.mute ? "on" : "off",
      JARVIS_AUDIO_LEVEL: opts.level === undefined ? "" : String(Math.max(0, Math.min(1, opts.level))),
    }),
  );
  if (!res.touched) {
    const who = opts.pid ? `pid ${opts.pid}` : proc;
    throw new Error(`у «${who}» нет активной звуковой сессии — глушить нечего (приложение молчит или закрыто)`);
  }
  log.info("звук приложения изменён", { touched: res.touched, sessions: res.sessions });
  return res;
}
