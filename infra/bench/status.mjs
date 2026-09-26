// Стенд: `bench status` — живость процессов, /healthz, коннект расширения, service worker, control фикстур, CDP, окна.
import { execFileSync } from "node:child_process";
import { DISPLAY, paths } from "./config.mjs";
import { cdp } from "./chrome.mjs";
import { control, healthz, readState, server } from "./client.mjs";
import { alive, readPid } from "./proc.mjs";
import { PROCS } from "./stack.mjs";

const safe = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

export async function status() {
  const p = paths();
  const state = readState(p);
  const procs = Object.fromEntries(PROCS.map((n) => [n, { pid: readPid(p.run, n), alive: alive(readPid(p.run, n)) }]));
  const up = Object.values(procs).every((x) => x.alive);
  const out = { dir: p.root, up, procs, startedAt: state?.startedAt ?? null };
  if (!Object.values(procs).some((x) => x.alive)) return out;
  out.healthz = await safe(async () => {
    const h = await healthz();
    return h ? { ok: h.ok, sessions: h.sessions } : null;
  });
  const st = await safe(() => server("GET", "/dev/bench/state", undefined, 5_000));
  out.ext = { connected: st?.ext?.connected === true, swAlive: state?.extId ? await safe(() => cdp.swAlive(state.extId)) : null };
  out.bench = st?.error ? { error: st.error } : { session: st?.session ?? null, busy: st?.busy, activeTasks: st?.activeTasks?.length ?? 0, stray: st?.stray?.length ?? 0 };
  out.sites = await safe(async () => {
    const h = await control("GET", "/health");
    return { ok: h.ok, events: h.events, hosts: Object.keys(h.hosts ?? {}) };
  });
  out.cdp = await safe(async () => ({ browser: (await cdp.version()).Browser, pages: (await cdp.pages()).map((t) => t.url) }));
  out.windows = await safe(() => execFileSync("wmctrl", ["-l"], { env: { ...process.env, DISPLAY }, encoding: "utf8" }).trim().split("\n").filter(Boolean));
  out.ready = up && out.ext.connected && out.sites?.ok === true && Boolean(out.healthz?.ok);
  return out;
}
