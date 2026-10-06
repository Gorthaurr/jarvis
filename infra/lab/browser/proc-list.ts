/**
 * Список chrome.exe на ПК (ТОЛЬКО чтение) с командными строками: по метке в cmd отличаем НАШИ процессы (каталог профиля
 * в %TEMP%/jarvis-lab) от Chrome владельца. Ничего не убивает и не трогает.
 */
import { execFile } from "node:child_process";

export interface ChromeProc {
  pid: number;
  cmd: string;
}

/** Все chrome.exe (win32); на другой платформе пусто. */
export function chromeProcs(): Promise<ChromeProc[]> {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve([]);
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }";
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 20_000, maxBuffer: 8_000_000 }, (err, out) => {
      if (err) return resolve([]);
      const rows = out.split(/\r?\n/u).map((l) => /^(\d+)\t(.*)$/u.exec(l));
      resolve(rows.flatMap((m) => (m ? [{ pid: Number(m[1]), cmd: m[2] ?? "" }] : [])));
    });
  });
}
