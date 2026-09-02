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

describe("lintCode — подпись и почта (рубежи, объявленные прозой, теперь код)", () => {
  it("РЕЛЬС — подпись документов БЛОКируется (63-ФЗ: необратимо и юридически значимо)", () => {
    // На машине владельца есть квалифицированный сертификат физлица с приватным ключом и КриптоПро CSP:
    // при закешированном PIN подпись поставится БЕЗ диалога, то есть незаметно.
    const cases: Array<[Parameters<typeof lintCode>[0], string]> = [
      ["powershell", "Set-AuthenticodeSignature -FilePath .\\dogovor.pdf -Certificate $c"],
      ["powershell", "set-authenticodesignature $f $c"], // регистр PowerShell не важен
      ["powershell", "& 'C:\\Program Files (x86)\\Crypto Pro\\CSP\\csptest.exe' -sfsign -sign -in d.pdf"],
      ["powershell", "cryptcp.exe -sign -dn 'Веселков' dogovor.pdf dogovor.pdf.sig"],
      ["python", "import subprocess; subprocess.run(['cryptcp', '-signf', 'akt.pdf'])"], // python шеллит на CLI
      ["node", "require('child_process').execSync('csptest -keyset -sign')"],
      ["powershell", "$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($p)"],
    ];
    for (const [lang, code] of cases) {
      const r = lintCode(lang, code);
      expect(r.ok, `${lang}: ${code}`).toBe(false);
      expect(r.violations[0]?.rule).toBe("sign");
      // Отказ ЧЕСТНЫЙ: объясняет необратимость и юридическую значимость, а не «нельзя и всё».
      expect(r.violations[0]?.message).toMatch(/63-ФЗ/);
      expect(r.violations[0]?.message).toMatch(/НЕОБРАТИМОЕ/);
    }
  });

  it("ПРОВЕРКА подписи и соседние слова НЕ блокируются (гард не съедает легитимное)", () => {
    // Get-AuthenticodeSignature только ЧИТАЕТ подпись — блокировать её было бы ложным запретом.
    expect(lintCode("powershell", "Get-AuthenticodeSignature C:/app/setup.exe").ok).toBe(true);
    expect(lintCode("powershell", "Get-ChildItem Cert:\\CurrentUser\\My | Select-Object Subject").ok).toBe(true);
    expect(lintCode("python", "signature = compute_hmac(payload)").ok).toBe(true);
    expect(lintCode("python", "from cryptography.hazmat.primitives import hashes").ok).toBe(true); // «crypto…» ≠ cryptcp
  });

  it("РЕЛЬС — отправка почты из code.run требует подтверждения владельца (§3), но не блок", () => {
    const cases: Array<[Parameters<typeof lintCode>[0], string]> = [
      ["python", "import smtplib\ns = smtplib.SMTP('smtp.mail.ru', 587)"],
      ["python", "from smtplib import SMTP_SSL\nSMTP_SSL('smtp.mail.ru', 465).send_message(m)"],
      ["powershell", "Send-MailMessage -To 'kate@example.com' -Subject 'hi' -SmtpServer smtp.mail.ru"],
      ["node", "require('child_process').execSync(\"python -c 'import smtplib'\")"], // язык не спасает от гарда
    ];
    for (const [lang, code] of cases) {
      const r = lintCode(lang, code);
      expect(r.ok, `${lang}: ${code}`).toBe(true); // владелец вправе попросить письмо
      expect(r.requiresConfirm, `${lang}: ${code}`).toBe(true);
      // Владелец должен видеть, ЗА ЧТО его спрашивают: в модалку влезают лишь первые 160 символов кода.
      expect(r.confirmReasons.join(" ")).toMatch(/письм/i);
    }
    // Работа с почтой БЕЗ отправки (чтение ящика) подтверждения не требует.
    expect(lintCode("python", "import imaplib; imaplib.IMAP4_SSL('imap.mail.ru').login(u, p)").requiresConfirm).toBe(false);
    // Соседние слова не ловятся: гард не должен спрашивать про SMTP-настройки в конфиге.
    expect(lintCode("python", "cfg = {'smtp_host': 'smtp.mail.ru'}").requiresConfirm).toBe(false);
  });

  it("confirmReasons пуст, когда подтверждение не нужно (модалка не выдумывает причину)", () => {
    const clean = lintCode("python", "print(2 + 2)");
    expect(clean.requiresConfirm).toBe(false);
    expect(clean.confirmReasons).toEqual([]);
  });
});
