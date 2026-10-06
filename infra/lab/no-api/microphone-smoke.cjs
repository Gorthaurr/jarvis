/** Real Electron + production AudioCapture. Keeps only frame counts, never microphone audio. */
const { resolve, join } = require("node:path");
const { writeFileSync, mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { createRequire } = require("node:module");
const root = resolve(__dirname, "../../..");
const clientRequire = createRequire(join(root, "apps/client/package.json"));
const renderer = join(root, "apps/client/dist/renderer");
const html = join(renderer, "microphone-smoke.html");

if (!process.versions.electron) {
  clientRequire("esbuild").buildSync({ entryPoints: [join(root, "apps/client/renderer/audio.ts")],
    outfile: join(renderer, "microphone-smoke.js"), bundle: true, format: "iife", platform: "browser", globalName: "JarvisAudio" });
  writeFileSync(html, '<!doctype html><meta charset="utf-8"><script src="./microphone-smoke.js"></script>');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const r = require("node:child_process").spawnSync(clientRequire("electron"), [__filename],
    { env, windowsHide: true, encoding: "utf8", timeout: 30_000 });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) console.error(r.error.message);
  process.exitCode = r.status ?? 1;
} else {
  const { app, BrowserWindow, session } = require("electron");
  app.setPath("userData", mkdtempSync(join(tmpdir(), "jarvis-microphone-smoke-")));
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
  app.whenReady().then(async () => {
    let win;
    try {
      session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media"));
      session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media");
      win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
      await win.loadFile(html);
      const result = await win.webContents.executeJavaScript(`(async () => {
        let frames = 0, bytes = 0, peak = 0;
        const capture = new JarvisAudio.AudioCapture(pcm => {
          frames++; bytes += pcm.byteLength;
          for (const sample of new Int16Array(pcm)) peak = Math.max(peak, Math.abs(sample));
        });
        try { await capture.start(); await new Promise(r => setTimeout(r, 3000)); }
        finally { await capture.stop(); }
        return { frames, bytes, peak, sampleRate: 16000, retainedAudio: false };
      })()`);
      console.log(JSON.stringify({ microphone: result }));
      if (result.frames < 20 || result.bytes === 0) throw new Error("Production microphone capture produced no frames");
      win.destroy(); app.exit(0);
    } catch (e) { console.error(e instanceof Error ? e.message : String(e)); win?.destroy(); app.exit(1); }
  });
}
