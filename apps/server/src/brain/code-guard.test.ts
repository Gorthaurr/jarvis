import { describe, expect, it } from "vitest";
import { lintCode } from "./code-guard.js";

describe("lintCode (§4 критичные рельсы; реальное управление Windows открыто)", () => {
  it("чистый python проходит", () => {
    const r = lintCode("python", "import openpyxl\nwb = openpyxl.Workbook()\nwb.save('out.xlsx')");
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
    expect(r.requiresConfirm).toBe(false);
  });

  it("РЕАЛЬНОЕ управление Windows ОТКРЫТО: сеть/реестр/службы/COM/пути — БЕЗ блока и БЕЗ confirm", () => {
    // Решение пользователя: безопасность из экспертизы агента, не из блок-листов возможностей.
    const cases: Array<[Parameters<typeof lintCode>[0], string]> = [
      ["python", "import socket; s = socket.socket()"],
      ["python", "import urllib.request; urllib.request.urlopen('http://x')"],
      ["python", "import winreg"],
      ["python", "import subprocess; subprocess.run(['nircmd'])"],
      ["python", "open(r'C:\\\\Windows\\\\system32\\\\x')"],
      ["node", "const cp = require('child_process'); cp.execSync('whoami')"],
      ["powershell", "Invoke-WebRequest http://x -OutFile t.exe"],
      ["powershell", "Stop-Service Spooler; Start-Service Spooler"],
      ["powershell", "Set-ItemProperty -Path 'HKCU:\\\\Software\\\\X' -Name Y -Value 1"],
      ["powershell", "Add-Type -TypeDefinition $src; [Audio]::SetDefault('Razer')"],
    ];
    for (const [lang, code] of cases) {
      const r = lintCode(lang, code);
      expect(r.ok, `${lang}: ${code}`).toBe(true);
      expect(r.requiresConfirm, `${lang}: ${code}`).toBe(false);
    }
  });

  it("read-only powershell — без confirm", () => {
    expect(lintCode("powershell", "Get-CimInstance -ClassName Win32_SoundDevice | Select-Object Name").requiresConfirm).toBe(false);
    expect(lintCode("powershell", "Get-Date").requiresConfirm).toBe(false);
  });

  it("РЕЛЬС §4 — необратимое (удаление/формат): НЕ блок, но confirm", () => {
    expect(lintCode("powershell", "Remove-Item C:/temp/x.txt").requiresConfirm).toBe(true);
    expect(lintCode("powershell", "Remove-Item C:/temp/x.txt").ok).toBe(true); // не блок — намеренно под подтверждением
    expect(lintCode("powershell", "Format-Volume -DriveLetter D").requiresConfirm).toBe(true);
    const py = lintCode("python", "import shutil; shutil.rmtree('C:/Users/x/data')");
    expect(py.ok).toBe(true);
    expect(py.requiresConfirm).toBe(true);
    const node = lintCode("node", "fs.rmSync('x', { recursive: true })");
    expect(node.requiresConfirm).toBe(true);
    // легитимный код без удаления — без confirm
    expect(lintCode("python", "import openpyxl\nopenpyxl.Workbook().save('o.xlsx')").requiresConfirm).toBe(false);
  });

  it("РЕЛЬС §4 — питание: выключение/перезагрузка из code.run ЗАПРЕЩЕНЫ (только system_power)", () => {
    expect(lintCode("powershell", "Stop-Computer -Force").ok).toBe(false);
    expect(lintCode("powershell", "Restart-Computer").ok).toBe(false);
    expect(lintCode("powershell", "shutdown /s /t 0").ok).toBe(false);
    expect(lintCode("python", "import os; os.system('shutdown /s /t 0')").ok).toBe(false); // слово shutdown ловится везде
  });

  it("РЕЛЬС §4 — самозащита: kill electron/node/sidecar по имени БЛОКируется, другие процессы — свободно", () => {
    // Нельзя убить сам Джарвис (инцидент «закрой Доту → закрылся Джарвис»).
    expect(lintCode("powershell", "taskkill /IM electron.exe /F").ok).toBe(false);
    expect(lintCode("powershell", "Stop-Process -Name node -Force").ok).toBe(false);
    expect(lintCode("powershell", "Get-Process electron | Stop-Process").ok).toBe(false); // обратный порядок
    expect(lintCode("powershell", "Stop-Process -Name SidecarWin").ok).toBe(false);
    // Другие процессы (игра, браузер) — завершай свободно, в т.ч. по PID (полное управление):
    expect(lintCode("powershell", "Stop-Process -Name dota2 -Force").ok).toBe(true);
    expect(lintCode("powershell", "Stop-Process -Name dota2 -Force").requiresConfirm).toBe(false);
    expect(lintCode("python", "import os; os.kill(1234, 9)").ok).toBe(true);
    expect(lintCode("node", "process.kill(1234)").ok).toBe(true);
    // «skill» НЕ должно ловиться как kill:
    expect(lintCode("python", "skill_node = run_skill('node-task')").ok).toBe(true);
  });
});
