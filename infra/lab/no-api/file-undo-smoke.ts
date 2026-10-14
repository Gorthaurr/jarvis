/** Настоящий Electron dispatcher, временные файлы, без окон/микрофона/синтеза. */
import { app } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ActionCommand } from "@jarvis/protocol";
import { dispatch } from "../../../apps/client/main/actuators/index.js";

const root = resolve(process.env.JARVIS_REPO_ROOT || process.cwd());
const scratch = mkdtempSync(join(tmpdir(), "jarvis-file-undo-smoke-"));
app.setPath("userData", join(scratch, "electron"));
const report: Record<string, unknown> = { scratch, realElectron: true, audio: false };
let sequence = 0;
const run = (cmd: ActionCommand) => dispatch(`file-undo-smoke-${++sequence}`, cmd);

app.whenReady().then(async () => {
  let code = 1;
  try {
    const path = join(scratch, "notes.txt");
    const original = Buffer.from("\uFEFFИсходные байты\r\n", "utf16le");
    await writeFile(path, original);
    const edited = await run({ kind: "fs.write", path, content: "Новая версия" });
    const id = (edited.data as { undoId?: string })?.undoId;
    if (!edited.ok || !id) throw new Error(`Write has no undo: ${JSON.stringify(edited)}`);
    const listed = await run({ kind: "fs.undo", op: "list" });
    if (!listed.ok || !JSON.stringify(listed.data).includes(id)) throw new Error("Snapshot not listed");
    const restored = await run({ kind: "fs.undo", op: "restore", id });
    if (!restored.ok || !(await readFile(path)).equals(original)) throw new Error("Byte-exact restoration failed");
    report.byteExact = true;
    const replay = await run({ kind: "fs.undo", op: "restore", id });
    if (replay.ok || !(await readFile(path)).equals(original)) throw new Error("Repeated id mutated file");
    report.repeatedIdRefused = true;
    const second = await run({ kind: "fs.write", path, content: "Ещё одна правка" });
    const secondId = (second.data as { undoId?: string })?.undoId;
    if (!second.ok || !secondId) throw new Error("Second snapshot missing");
    await writeFile(path, "Правка владельца");
    const conflict = await run({ kind: "fs.undo", op: "restore", id: secondId });
    if (conflict.ok || await readFile(path, "utf8") !== "Правка владельца") throw new Error("Conflict overwrote user data");
    report.conflictPreserved = true;
    report.ok = true;
    code = 0;
  } catch (error) { report.ok = false; report.error = String(error); }
  finally {
    await mkdir(join(root, "docs/lab/runs"), { recursive: true });
    await writeFile(join(root, "docs/lab/runs/file-undo-electron.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    app.exit(code);
  }
});
