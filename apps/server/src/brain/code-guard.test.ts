import { describe, expect, it } from "vitest";
import { lintCode } from "./code-guard.js";

describe("lintCode (§6, §14)", () => {
  it("чистый python проходит", () => {
    const r = lintCode("python", "import openpyxl\nwb = openpyxl.Workbook()\nwb.save('out.xlsx')");
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
    expect(r.requiresConfirm).toBe(false);
  });

  it("сеть в python отклоняется", () => {
    const r = lintCode("python", "import socket\ns = socket.socket()");
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.rule === "network")).toBe(true);
  });

  it("реестр/службы/сеть в powershell отклоняются и требуют confirm", () => {
    const r = lintCode("powershell", "Invoke-WebRequest http://x; Stop-Service foo");
    expect(r.ok).toBe(false);
    expect(r.requiresConfirm).toBe(true); // powershell всегда confirm (§6)
    const rules = r.violations.map((v) => v.rule);
    expect(rules).toContain("network");
    expect(rules).toContain("services");
  });

  it("node: child_process и eval отклоняются", () => {
    expect(lintCode("node", "const cp = require('child_process')").ok).toBe(false);
    expect(lintCode("node", "eval('2+2')").ok).toBe(false);
  });

  it("системные пути отклоняются", () => {
    expect(lintCode("python", "open(r'C:\\\\Windows\\\\system32\\\\x')").ok).toBe(false);
  });

  it("обфускация в python отклоняется (__import__/subprocess/os.popen/ctypes)", () => {
    expect(lintCode("python", "__import__('os').system('x')").ok).toBe(false);
    expect(lintCode("python", "import subprocess; subprocess.run(['x'])").ok).toBe(false);
    expect(lintCode("python", "import os; os.popen('x')").ok).toBe(false);
    expect(lintCode("python", "import ctypes").ok).toBe(false);
  });

  it("обфускация в node отклоняется (process.binding/import()/Function)", () => {
    expect(lintCode("node", "process.binding('spawn_sync')").ok).toBe(false);
    expect(lintCode("node", "import('child_process')").ok).toBe(false);
    expect(lintCode("node", "Function('return 2')()").ok).toBe(false);
  });

  it("чистый powershell проходит lint, но всё равно requiresConfirm", () => {
    const r = lintCode("powershell", "Get-Date");
    expect(r.ok).toBe(true);
    expect(r.requiresConfirm).toBe(true);
  });

  it("удаление файлов из code.run не блокируется, но ТРЕБУЕТ confirm (§4)", () => {
    const py = lintCode("python", "import shutil; shutil.rmtree('C:/Users/x/data')");
    expect(py.ok).toBe(true); // не блок
    expect(py.requiresConfirm).toBe(true); // но через подтверждение
    const node = lintCode("node", "fs.rmSync('x', { recursive: true })");
    expect(node.ok).toBe(true);
    expect(node.requiresConfirm).toBe(true);
    // легитимный код без удаления — без confirm
    expect(lintCode("python", "import openpyxl\nwb = openpyxl.Workbook()\nwb.save('o.xlsx')").requiresConfirm).toBe(false);
  });
});
