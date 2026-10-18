// Owns only the process and fresh directory created for one browser test.
import { execFile, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function withBrowserFixture(prefix, start) {
  const parent = resolve(tmpdir());
  const dir = resolve(mkdtempSync(join(parent, prefix)));
  let proc, spawnError, exit, closing;
  let closeTransport = () => {};
  const fixture = {
    dir,
    spawn(command, args, options) {
      proc = spawn(command, args, options);
      exit = new Promise((done) => {
        proc.once("exit", done);
        proc.once("error", (error) => { spawnError = error; done(); });
      });
      return proc;
    },
    onClose(callback) { closeTransport = callback; },
    assertRunning() {
      if (spawnError) throw spawnError;
      if (proc && (proc.exitCode !== null || proc.signalCode !== null)) {
        throw new Error(`Chrome exited before the fixture was ready (${proc.exitCode ?? proc.signalCode})`);
      }
    },
    close() {
      return closing ??= (async () => {
        try { closeTransport(); } finally {
          if (proc?.pid && proc.exitCode === null && proc.signalCode === null) {
            let stopError;
            if (process.platform === "win32") {
              const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
              try { await exec(taskkill, ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 }); }
              catch (error) { stopError = error; }
            } else proc.kill("SIGKILL");
            // Closing CDP can exit Chrome while taskkill enumerates its tree. The exit event is decisive.
            let timer;
            try {
              await Promise.race([exit, new Promise((_, reject) => {
                timer = setTimeout(() => reject(stopError ?? new Error("Browser fixture process did not exit")), 10_000);
              })]);
            } finally { clearTimeout(timer); }
          }
          // Verify the resolved target before recursive deletion; never accept caller-provided paths.
          if (dirname(dir) !== parent) throw new Error("Browser fixture escaped its temporary parent");
          await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
      })();
    },
  };
  try { return await start(fixture); }
  catch (error) {
    try { await fixture.close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Browser startup and fixture cleanup failed"); }
    throw error;
  }
}
