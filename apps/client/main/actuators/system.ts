/**
 * Системные актуаторы (§6): питание, блокировка, медиа, громкость, буфер обмена.
 *
 * Все команды строятся ЧИСТОЙ функцией planSystem из фиксированных enum'ов протокола —
 * никакой интерполяции пользовательских строк в shell (анти-инъекция, см. §6 apps.focus).
 * Текст для записи в буфер передаётся через переменную окружения, а не в командную строку.
 *
 * Блокировка/сон — безопасны и обратимы (без confirm). Выключение/перезагрузка/выход —
 * необратимы, требуют user.confirm на сервере (§4).
 */
import { spawn } from "node:child_process";
import type { ActionCommand } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";

const log = createLogger("actuator:system");

/** VK-коды media/volume клавиш (WinUser.h). Числовые — безопасны для подстановки. */
const VK = {
  mute: 173, volDown: 174, volUp: 175,
  next: 176, prev: 177, stop: 178, playPause: 179,
} as const;

type SysCmd = Extract<ActionCommand, { kind: `system.${string}` }>;

export interface SystemPlan {
  exe: string;
  args: string[];
  /** Доп. переменные окружения (напр. текст буфера — мимо командной строки). */
  env?: Record<string, string>;
  /** true — вернуть stdout как результат (clipboard read). */
  captureStdout?: boolean;
}

/** Скрипт PowerShell, шлющий media/volume-клавишу через keybd_event (VK фиксирован). */
function keyScript(vk: number): string {
  return (
    "$s=Add-Type -Name Kbd -Namespace JarvisWin -PassThru -MemberDefinition " +
    "'[DllImport(\"user32.dll\")] public static extern void keybd_event(byte k,byte sc,uint f,System.UIntPtr e);';" +
    `$s::keybd_event(${vk},0,0,[System.UIntPtr]::Zero);$s::keybd_event(${vk},0,2,[System.UIntPtr]::Zero)`
  );
}

/** Скрипт абсолютной громкости через Core Audio (SetMasterVolumeLevelScalar). */
function volumeSetScript(level: number): string {
  const safe = Number.isFinite(level) ? level : 50; // защита от NaN (?? не ловит NaN)
  const scalar = (Math.min(100, Math.max(0, safe)) / 100).toFixed(3);
  return (
    "Add-Type -TypeDefinition '" +
    "using System.Runtime.InteropServices;" +
    "[Guid(\"5CDF2C82-841E-4546-9722-0CF74078229A\"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAEV{int a();int b();int SetMasterVolumeLevelScalar(float v,System.Guid g);}" +
    "[Guid(\"D666063F-1587-4E43-81F1-B948E807363F\"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMD{int Activate(ref System.Guid id,int ctx,System.IntPtr p,[MarshalAs(UnmanagedType.IUnknown)] out object o);}" +
    "[Guid(\"A95664D2-9614-4F35-A746-DE8DB63617E6\"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDE{int EnumAudioEndpoints(int f,int s,System.IntPtr p);int GetDefaultAudioEndpoint(int f,int r,out IMMD e);}" +
    "[ComImport,Guid(\"BCDE0395-E52F-467C-8E3D-C4579291692E\")] class MMDEC{}" +
    "public static class Vol{public static void Set(float v){var e=(IMMDE)(new MMDEC());IMMD d;e.GetDefaultAudioEndpoint(0,1,out d);var g=typeof(IAEV).GUID;object o;d.Activate(ref g,1,System.IntPtr.Zero,out o);((IAEV)o).SetMasterVolumeLevelScalar(v,System.Guid.Empty);}}" +
    `';[Vol]::Set(${scalar})`
  );
}

/** Построить план исполнения системной команды (чистая, тестируемая). */
export function planSystem(cmd: SysCmd): SystemPlan {
  switch (cmd.kind) {
    case "system.lock":
      return { exe: "rundll32.exe", args: ["user32.dll,LockWorkStation"] };
    case "system.power":
      switch (cmd.op) {
        case "sleep":
          return { exe: "rundll32.exe", args: ["powrprof.dll,SetSuspendState", "0,1,0"] };
        case "shutdown":
          return { exe: "shutdown", args: ["/s", "/t", "0"] };
        case "restart":
          return { exe: "shutdown", args: ["/r", "/t", "0"] };
        case "logoff":
          return { exe: "shutdown", args: ["/l"] };
      }
      break;
    case "system.media": {
      const vk = cmd.op === "next" ? VK.next : cmd.op === "prev" ? VK.prev : cmd.op === "stop" ? VK.stop : VK.playPause;
      return ps(keyScript(vk));
    }
    case "system.volume": {
      if (cmd.op === "set") return ps(volumeSetScript(cmd.level ?? 50));
      const vk = cmd.op === "mute" ? VK.mute : cmd.op === "up" ? VK.volUp : VK.volDown;
      return ps(keyScript(vk));
    }
    case "system.clipboard":
      if (cmd.op === "read") return { ...ps("[Console]::Out.Write((Get-Clipboard -Raw))"), captureStdout: true };
      // write: текст через env — мимо командной строки (анти-инъекция).
      return { ...ps("Set-Clipboard -Value $env:JARVIS_CLIP"), env: { JARVIS_CLIP: cmd.text ?? "" } };
  }
  // Недостижимо при корректном union, но даём явную ошибку.
  throw new Error(`unknown system command: ${JSON.stringify(cmd)}`);
}

function ps(script: string): SystemPlan {
  return { exe: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
}

/** Исполнить системную команду. Возвращает данные для ActionResult.data. */
export async function runSystem(cmd: SysCmd): Promise<{ ok: true; stdout?: string }> {
  const plan = planSystem(cmd);
  log.info(`system.${cmd.kind.split(".")[1]}`, { exe: plan.exe });
  const stdout = await exec(plan);
  return plan.captureStdout ? { ok: true, stdout } : { ok: true };
}

function exec(plan: SystemPlan): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(plan.exe, plan.args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: plan.env ? { ...process.env, ...plan.env } : process.env,
    });
    let out = "";
    let err = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => { if (out.length < 1_000_000) out += d; });
    child.stderr?.on("data", (d: string) => { err += String(d); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === null) resolve(out);
      else reject(new Error(`${plan.exe} вернул код ${code}${err ? `: ${err.slice(0, 200)}` : ""}`));
    });
    // Сон/блокировка завершаются мгновенно; страховочный таймаут на зависание.
    setTimeout(() => resolve(out), 8000).unref?.();
  });
}
