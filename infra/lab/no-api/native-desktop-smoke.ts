/** Настоящий Electron dispatcher + Windows sidecar + собственное окно Блокнота. */
import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dispatch } from "../../../apps/client/main/actuators/index.js";
import { sidecar } from "../../../apps/client/main/actuators/sidecar-client.js";
import type { ActionCommand } from "@jarvis/protocol";

const root = resolve(process.env.JARVIS_REPO_ROOT || process.cwd());
const scratch = mkdtempSync(join(tmpdir(), "jarvis-native-smoke-"));
app.setPath("userData", join(scratch, "electron"));
const marker = "JARVIS-NATIVE-READBACK-42";
const file = join(scratch, "jarvis-native-readback.txt");
let notepad: ChildProcess | undefined;
let originalHwnd: number | undefined;
const checks: Record<string, unknown> = {};
type OwnedWindow = { hwnd: number; pid: number; title: string };
const run = async (cmd: ActionCommand) => {
  const r = await dispatch(`native-smoke-${Date.now()}`, cmd);
  if (!r.ok) throw new Error(`${cmd.kind}: ${r.error?.message}`);
  return r.data as Record<string, unknown>;
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let code = 1;
  try {
    const base = join(root, "apps/sidecar-win/bin");
    const exe = readdirSync(base, { recursive: true }).map(String).find((p) => p.endsWith("SidecarWin.exe") && p.includes("publish") && p.includes("net8.0-windows10.0.19041.0"));
    if (!exe) throw new Error("Published Windows sidecar missing");
    sidecar().start(join(base, exe));
    await run({ kind: "fs.write", path: file, content: marker, createDirs: true });
    const readback = await run({ kind: "fs.read", path: file });
    if (readback.content !== marker || readFileSync(file, "utf8") !== marker) throw new Error("Filesystem readback mismatch");
    checks.filesystem = true;
    const before = await run({ kind: "window.list" });
    originalHwnd = (before.windows as { hwnd: number; foreground?: boolean }[]).find((w) => w.foreground)?.hwnd;
    notepad = spawn(join(process.env.SystemRoot || "C:/Windows", "System32/notepad.exe"), [file], { stdio: "ignore" });
    const ownPid = notepad.pid;
    let own: OwnedWindow | undefined;
    for (let n = 0; n < 30 && !own; n++) {
      await delay(200);
      const list = await run({ kind: "window.list" });
      own = (list.windows as OwnedWindow[]).find((w) => w.pid === ownPid && w.title.includes("jarvis-native-readback"));
    }
    if (!own) throw new Error("Owned Notepad window did not appear");
    const focus = await run({ kind: "window.focus", hwnd: own.hwnd });
    if (focus.focused !== true) throw new Error("Window focus not confirmed");
    checks.windowFocus = true;
    const snapshot = await run({ kind: "ui.snapshot", pid: own.pid, maxItems: 80 });
    checks.uiaSnapshot = Boolean(snapshot);
    const context = await run({ kind: "context.read", scope: "active_window" });
    if (!JSON.stringify(context).includes(marker)) throw new Error("Native UI readback did not contain the test marker");
    checks.nativeReadback = true;
    code = 0;
  } catch (e) { checks.error = e instanceof Error ? e.message : String(e); }
  finally {
    if (notepad && notepad.exitCode === null) notepad.kill();
    if (originalHwnd) await run({ kind: "window.focus", hwnd: originalHwnd }).catch(() => {});
    sidecar().stop();
    writeFileSync(join(root, "docs/lab/runs/no-api-native-desktop.json"), JSON.stringify(checks, null, 2));
    try { console.log(JSON.stringify(checks)); } finally { app.exit(code); }
  }
});
