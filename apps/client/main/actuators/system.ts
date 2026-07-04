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

/**
 * ЗАЩИТА ОТ ВЫКЛЮЧЕНИЯ БЕЗ ПРЕДУПРЕЖДЕНИЯ (§4): shutdown/restart НИКОГДА не исполняются мгновенно
 * (`/t 0`). Делаем отложенный shutdown с окном предупреждения ОС (`/t N /c …`) — пользователь видит
 * штатное уведомление Windows и успевает отменить (`op:"cancel"` → `shutdown /a` или системно).
 * Окно настраивается env JARVIS_SHUTDOWN_DELAY_SEC (по умолчанию 25с, клампится в [5, 600]).
 */
const SHUTDOWN_DELAY_SEC = (() => {
  const raw = Number.parseInt(process.env.JARVIS_SHUTDOWN_DELAY_SEC ?? "", 10);
  return Number.isFinite(raw) ? Math.min(600, Math.max(5, raw)) : 25;
})();

/** Текст предупреждения для штатного диалога Windows (`shutdown /c`). */
function powerWarn(action: string, sec: number): string {
  return `Джарвис: ${action} через ${sec} сек. Передумали — скажите «отмена».`;
}

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
  /** true — ненулевой код выхода НЕ ошибка (напр. `shutdown /a`, когда отменять нечего). */
  tolerateFailure?: boolean;
}

/** Скрипт PowerShell, шлющий media/volume-клавишу через keybd_event (VK фиксирован). */
function keyScript(vk: number): string {
  return (
    "$s=Add-Type -Name Kbd -Namespace JarvisWin -PassThru -MemberDefinition " +
    "'[DllImport(\"user32.dll\")] public static extern void keybd_event(byte k,byte sc,uint f,System.UIntPtr e);';" +
    `$s::keybd_event(${vk},0,0,[System.UIntPtr]::Zero);$s::keybd_event(${vk},0,2,[System.UIntPtr]::Zero)`
  );
}

/**
 * Core Audio IAudioEndpointVolume через COM (§ verify-loop): get/set/step/mute с КОРРЕКТНЫМ vtable
 * и ОБРАТНЫМ ЧТЕНИЕМ результата (раньше IAEV объявлял SetMasterVolumeLevelScalar на неверном слоте —
 * фактически звался GetChannelCount, громкость молча НЕ менялась, но возвращался «ok». Проверено
 * вживую: корректные слоты set+get работают). Стабы f0..f10 держат позиции методов в vtable.
 */
const VOL_TYPE =
  "Add-Type -TypeDefinition '" +
  "using System.Runtime.InteropServices;" +
  "[Guid(\"5CDF2C82-841E-4546-9722-0CF74078229A\"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAEV{int f0();int f1();int f2();int f3();int SetMasterVolumeLevelScalar(float v,System.Guid g);int f5();int GetMasterVolumeLevelScalar(out float v);int f7();int f8();int f9();int f10();int SetMute(bool m,System.Guid g);int GetMute(out bool m);}" +
  "[Guid(\"D666063F-1587-4E43-81F1-B948E807363F\"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMD{int Activate(ref System.Guid id,int ctx,System.IntPtr p,[MarshalAs(UnmanagedType.IUnknown)] out object o);}" +
  "[Guid(\"A95664D2-9614-4F35-A746-DE8DB63617E6\"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDE{int f0();int GetDefaultAudioEndpoint(int f,int r,out IMMD e);}" +
  "[ComImport,Guid(\"BCDE0395-E52F-467C-8E3D-C4579291692E\")] class MMDEC{}" +
  "public static class Vol{static IAEV E(){var e=(IMMDE)(new MMDEC());IMMD d;e.GetDefaultAudioEndpoint(0,1,out d);var g=typeof(IAEV).GUID;object o;d.Activate(ref g,1,System.IntPtr.Zero,out o);return (IAEV)o;}" +
  "public static float Get(){float v;E().GetMasterVolumeLevelScalar(out v);return v;}" +
  "public static void Set(float v){E().SetMasterVolumeLevelScalar(v,System.Guid.Empty);}" +
  "public static bool GetMute(){bool m;E().GetMute(out m);return m;}" +
  "public static void SetMute(bool m){E().SetMute(m,System.Guid.Empty);}}" +
  "';";
/** Печать текущей громкости 0..100 — общий «обратный отсчёт» для verify-loop. */
const VOL_PRINT = "[Console]::Out.Write([int][math]::Round([Vol]::Get()*100))";
// Core Audio применяет SetMasterVolumeLevelScalar АСИНХРОННО: Get() сразу после Set() в том же
// процессе читает СТАРОЕ значение (поймано реальным интеграционным тестом — up/down возвращали
// оба раза 100). Короткая пауза перед обратным чтением → readback видит фактическое значение.
const VOL_SETTLE = "Start-Sleep -Milliseconds 150;";

/** set: задать уровень → ВЕРНУТЬ фактический (readback после settle). */
function volumeSetScript(level: number): string {
  const safe = Number.isFinite(level) ? level : 50; // защита от NaN (?? не ловит NaN)
  const scalar = (Math.min(100, Math.max(0, safe)) / 100).toFixed(3);
  return `${VOL_TYPE}[Vol]::Set(${scalar});${VOL_SETTLE}${VOL_PRINT}`;
}
/** get: только прочитать текущий уровень (для verify-loop). */
function volumeGetScript(): string {
  return `${VOL_TYPE}${VOL_PRINT}`;
}
/** up/down: шаг ±10% через Core Audio (детерминированно, НЕ глобальная клавиша) → вернуть фактический. */
function volumeStepScript(deltaScalar: number): string {
  // КРИТИЧНО: клампим double-литералами 0.0/1.0. С [int] 0/1 PowerShell-overload [math]::Min(1,0.6)
  // коэрсит 0.6→1 (под Min(int,int)) → Set(1)=100% (поймано реальным интеграционным тестом).
  return `${VOL_TYPE}$c=[Vol]::Get();$n=[math]::Max(0.0,[math]::Min(1.0,$c+(${deltaScalar.toFixed(3)})));[Vol]::Set([float]$n);${VOL_SETTLE}${VOL_PRINT}`;
}
/** mute: переключить через SetMute (не глобальная клавиша) → вернуть состояние. */
function volumeMuteScript(): string {
  return `${VOL_TYPE}$m=[Vol]::GetMute();[Vol]::SetMute(-not $m);[Console]::Out.Write($(if([Vol]::GetMute()){'muted'}else{'unmuted'}))`;
}

/**
 * Наблюдение «реально ли идёт звук» (§ verify-loop): WASAPI peak-meter дефолтного устройства вывода.
 * persona требует «не говори играет без подтверждения звука» — это инструмент подтверждения. Семплим
 * пик 5× за ~300мс (музыка имеет тихие моменты) и берём максимум. Проверено вживую (peak 0.068→PLAYING).
 */
function audioPeakScript(): string {
  return (
    "Add-Type -TypeDefinition '" +
    "using System.Runtime.InteropServices;" +
    "[Guid(\"C02216F6-8C67-4B5B-9D00-D008E73E0064\"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAMI{int GetPeakValue(out float v);}" +
    "[Guid(\"D666063F-1587-4E43-81F1-B948E807363F\"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMD{int Activate(ref System.Guid id,int ctx,System.IntPtr p,[MarshalAs(UnmanagedType.IUnknown)] out object o);}" +
    "[Guid(\"A95664D2-9614-4F35-A746-DE8DB63617E6\"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDE{int f0();int GetDefaultAudioEndpoint(int f,int r,out IMMD e);}" +
    "[ComImport,Guid(\"BCDE0395-E52F-467C-8E3D-C4579291692E\")] class MMDEC{}" +
    "public static class Meter{public static float Peak(){var e=(IMMDE)(new MMDEC());IMMD d;e.GetDefaultAudioEndpoint(0,1,out d);var g=typeof(IAMI).GUID;object o;d.Activate(ref g,1,System.IntPtr.Zero,out o);float v;((IAMI)o).GetPeakValue(out v);return v;}}" +
    "';$m=0.0;1..5|%{$p=[Meter]::Peak();if($p -gt $m){$m=$p};Start-Sleep -Milliseconds 60};[Console]::Out.Write([math]::Round($m,4))"
  );
}

/**
 * Переключить РАСКЛАДКУ клавиатуры окна на переднем плане (§ «действуй как игрок» — в играх нет API).
 * Через Win32: LoadKeyboardLayout(KLF_ACTIVATE) + WM_INPUTLANGCHANGEREQUEST (0x50) в foreground-окно,
 * чтобы раскладку получила ИГРА/активное приложение, а не только наш процесс. Итог читаем обратно
 * (langid потока окна) → печатаем hex для verify-loop. toggle = другая из en(0409)/ru(0419).
 * lang приходит из enum протокола (en|ru|toggle) — подставляется безопасно, не из пользовательской строки.
 */
function layoutScript(lang: "en" | "ru" | "toggle"): string {
  return (
    "$t=Add-Type -Name Lay -Namespace JarvisWin -PassThru -MemberDefinition '" +
    '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();' +
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h,System.IntPtr p);' +
    '[DllImport("user32.dll")] public static extern System.IntPtr GetKeyboardLayout(uint t);' +
    '[DllImport("user32.dll")] public static extern System.IntPtr LoadKeyboardLayout(string id,uint f);' +
    '[DllImport("user32.dll")] public static extern System.IntPtr PostMessage(System.IntPtr h,uint m,System.IntPtr w,System.IntPtr l);' +
    "';" +
    "$h=$t::GetForegroundWindow();" +
    "$tid=$t::GetWindowThreadProcessId($h,[System.IntPtr]::Zero);" +
    "$cur=($t::GetKeyboardLayout($tid).ToInt64() -band 0xFFFF);" +
    `$want='${lang}';` +
    "if($want -eq 'en'){$id='00000409'}elseif($want -eq 'ru'){$id='00000419'}else{if($cur -eq 0x419){$id='00000409'}else{$id='00000419'}};" +
    "$hkl=$t::LoadKeyboardLayout($id,1);" +
    "$t::PostMessage($h,0x50,[System.IntPtr]::Zero,$hkl)|Out-Null;" +
    "Start-Sleep -Milliseconds 120;" +
    "$now=($t::GetKeyboardLayout($t::GetWindowThreadProcessId($h,[System.IntPtr]::Zero)).ToInt64() -band 0xFFFF);" +
    "[Console]::Out.Write(('{0:x4}' -f $now))"
  );
}

/** Построить план исполнения системной команды (чистая, тестируемая). delaySec — окно отмены. */
export function planSystem(cmd: SysCmd, delaySec: number = SHUTDOWN_DELAY_SEC): SystemPlan {
  switch (cmd.kind) {
    case "system.lock":
      return { exe: "rundll32.exe", args: ["user32.dll,LockWorkStation"] };
    case "system.power":
      switch (cmd.op) {
        case "sleep":
          return { exe: "rundll32.exe", args: ["powrprof.dll,SetSuspendState", "0,1,0"] };
        // ЗАЩИТА (§4): отложенный shutdown/restart с предупреждением ОС и окном отмены —
        // НИКОГДА не `/t 0`. Пользователь успевает отменить (op:"cancel").
        case "shutdown":
          return { exe: "shutdown", args: ["/s", "/t", String(delaySec), "/c", powerWarn("выключение", delaySec)] };
        case "restart":
          return { exe: "shutdown", args: ["/r", "/t", String(delaySec), "/c", powerWarn("перезагрузка", delaySec)] };
        case "logoff":
          return { exe: "shutdown", args: ["/l"] };
        case "cancel":
          // Отмена запланированного выключения/перезагрузки. Если отменять нечего — не ошибка.
          return { exe: "shutdown", args: ["/a"], tolerateFailure: true };
      }
      break;
    case "system.media": {
      // state — НАБЛЮДЕНИЕ (идёт ли звук), не клавиша → verify-loop для «реально ли играет».
      if (cmd.op === "state") return { ...ps(audioPeakScript()), captureStdout: true };
      const vk = cmd.op === "next" ? VK.next : cmd.op === "prev" ? VK.prev : cmd.op === "stop" ? VK.stop : VK.playPause;
      return ps(keyScript(vk));
    }
    case "system.volume": {
      // Всё через Core Audio (детерминированно + ОБРАТНОЕ ЧТЕНИЕ = verify-loop), НЕ глобальные клавиши.
      const script =
        cmd.op === "get" ? volumeGetScript()
        : cmd.op === "set" ? volumeSetScript(cmd.level ?? 50)
        : cmd.op === "mute" ? volumeMuteScript()
        : volumeStepScript(cmd.op === "up" ? 0.1 : -0.1);
      return { ...ps(script), captureStdout: true };
    }
    case "system.clipboard":
      if (cmd.op === "read") return { ...ps("[Console]::Out.Write((Get-Clipboard -Raw))"), captureStdout: true };
      // write: текст через env — мимо командной строки (анти-инъекция).
      return { ...ps("Set-Clipboard -Value $env:JARVIS_CLIP"), env: { JARVIS_CLIP: cmd.text ?? "" } };
    case "system.layout":
      return { ...ps(layoutScript(cmd.lang)), captureStdout: true };
  }
  // Недостижимо при корректном union, но даём явную ошибку.
  throw new Error(`unknown system command: ${JSON.stringify(cmd)}`);
}

function ps(script: string): SystemPlan {
  // UTF-8 вывод: node читает stdout как utf8 (exec setEncoding), а PS по умолчанию пишет в кодировке
  // консоли (cp866 на рус. Windows) → не-ASCII (кириллица/греческий в буфере обмена) бился в мохибейк.
  // Форсируем UTF-8 OutputEncoding — для ASCII-выводов (громкость/медиа) безвредно. (§честность данных)
  const utf8 = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;";
  return { exe: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", utf8 + script] };
}

/** Исполнить системную команду. Возвращает данные для ActionResult.data. */
export async function runSystem(cmd: SysCmd): Promise<{ ok: true; stdout?: string; level?: number; muted?: boolean; playing?: boolean; peak?: number }> {
  const plan = planSystem(cmd);
  log.info(`system.${cmd.kind.split(".")[1]}`, { exe: plan.exe });
  const stdout = await exec(plan);
  // VERIFY-LOOP звука (§ надёжность): «реально ли играет» по WASAPI peak.
  if (cmd.kind === "system.media" && cmd.op === "state") {
    const peak = Number.parseFloat((stdout ?? "").trim());
    const p = Number.isFinite(peak) ? peak : 0;
    return { ok: true, playing: p > 0.001, peak: p };
  }
  // VERIFY-LOOP громкости (§ надёжность): скрипт вернул ФАКТИЧЕСКИЙ результат после действия.
  if (cmd.kind === "system.volume") {
    const raw = (stdout ?? "").trim();
    if (cmd.op === "mute") return { ok: true, muted: raw === "muted" };
    const level = Number.parseInt(raw, 10);
    // set с обратной сверкой: не сошлось (раньше молча «ok», громкость не менялась) → ЧЕСТНЫЙ провал.
    if (cmd.op === "set" && cmd.level != null && (!Number.isFinite(level) || Math.abs(level - cmd.level) > 3)) {
      throw new Error(`громкость не установилась: просил ${cmd.level}, по факту ${Number.isFinite(level) ? level : "нет ответа"}`);
    }
    return { ok: true, level: Number.isFinite(level) ? level : undefined };
  }
  // VERIFY-LOOP раскладки: скрипт вернул фактический langid после переключения. Для явного en/ru —
  // если не переключилось, ЧЕСТНЫЙ провал (а не ложное «сделал»). toggle — просто сообщаем итог.
  if (cmd.kind === "system.layout") {
    const langid = (stdout ?? "").trim().toLowerCase();
    const got = langid === "0409" ? "en" : langid === "0419" ? "ru" : langid || "неизвестно";
    if ((cmd.lang === "en" || cmd.lang === "ru") && got !== cmd.lang) {
      throw new Error(`раскладка не переключилась на ${cmd.lang}: сейчас ${got}`);
    }
    return { ok: true, stdout: got };
  }
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
    // Страховочный таймаут на зависание (COM-громкость/буфер обмена умеют вешаться). Снимаем его в
    // close/error; по срабатыванию УБИВАЕМ процесс, иначе осиротевший powershell утекает.
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* уже мёртв */
      }
      resolve(out);
    }, 8000);
    timer.unref?.();
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // tolerateFailure: ненулевой код — норма (напр. `shutdown /a`, когда отменять нечего → 1116).
      if (code === 0 || code === null || plan.tolerateFailure) resolve(out);
      else reject(new Error(`${plan.exe} вернул код ${code}${err ? `: ${err.slice(0, 200)}` : ""}`));
    });
  });
}
