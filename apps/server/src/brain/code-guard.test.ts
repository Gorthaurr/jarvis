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

  it("чистый powershell проходит lint, но всё равно requiresConfirm", () => {
    const r = lintCode("powershell", "Get-Date");
    expect(r.ok).toBe(true);
    expect(r.requiresConfirm).toBe(true);
  });
});
