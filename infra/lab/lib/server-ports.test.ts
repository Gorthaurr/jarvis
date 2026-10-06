import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { claimPort as claimLabPort, createPortPool, isPortFree, releasePort as releaseLabPort } from "./server-ports.js";
import { tsxLoaderUrl } from "./server-proc.js";

const exec = promisify(execFile);
const moduleUrl = new URL("./server-ports.ts", import.meta.url).href;
let namespace: number;
let pool: ReturnType<typeof createPortPool>;
beforeAll(async () => {
  // Hold the public lease for this entire test file; no competing lab/worker can own the derived private pool.
  namespace = await claimLabPort();
  pool = createPortPool(namespace + 10_000, namespace + 10_000);
});
afterAll(() => releaseLabPort(namespace));
const claimPort = (preferred?: number) => pool.claimPort(preferred);
const releasePort = (port: number) => pool.releasePort(port);

async function claimInOtherProcess(port: number): Promise<{ ok: boolean; error?: string }> {
  const code = `import {createPortPool} from ${JSON.stringify(moduleUrl)};
    const {claimPort,releasePort}=createPortPool(${port},${port});
    try { const port=await claimPort(${port}); console.log(JSON.stringify({ok:true})); releasePort(port); }
    catch(error) { console.log(JSON.stringify({ok:false,error:error.message})); }`;
  const { stdout } = await exec(process.execPath, ["--import", tsxLoaderUrl(), "--input-type=module", "-e", code],
    { windowsHide: true, timeout: 15_000 });
  return JSON.parse(stdout) as { ok: boolean; error?: string };
}

it("reserves a still-unbound HTTP port across workers until the owning lab releases it", async () => {
  const port = await claimPort();
  try {
    expect(await isPortFree(port)).toBe(true); // migration is still running; child server has not bound yet
    const other = await claimInOtherProcess(port);
    expect(other.ok).toBe(false);
    expect(other.error).toContain("занят");
  } finally { releasePort(port); }
  expect((await claimInOtherProcess(port)).ok).toBe(true);
});

it("a busy HTTP port does not leave a reservation behind after the failed claim", async () => {
  const port = await claimPort(); releasePort(port);
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  try { await expect(claimPort(port)).rejects.toThrow("занят"); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  expect((await claimInOtherProcess(port)).ok).toBe(true);
});

it("a dead worker releases its reservation without stale files or manual cleanup", async () => {
  const port = await claimPort(); releasePort(port);
  const code = `import {createPortPool} from ${JSON.stringify(moduleUrl)};
    const {claimPort}=createPortPool(${port},${port});
    await claimPort(${port}); process.send('reserved'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--import", tsxLoaderUrl(), "--input-type=module", "-e", code],
    { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve()); child.once("error", reject);
      child.once("exit", () => reject(new Error("worker exited before reserving")));
    });
    await expect(claimPort(port)).rejects.toThrow("занят");
    const exited = once(child, "exit"); child.kill(); await exited;
    expect(await claimPort(port)).toBe(port);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    releasePort(port);
  }
});
