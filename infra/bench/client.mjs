// Стенд: HTTP к серверу Джарвиса (dev-токен из state.json) и к control фикстур; состояние стенда; сохранение картинок.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PORTS, paths } from "./config.mjs";

export function readState(p = paths()) {
  try {
    return JSON.parse(readFileSync(p.state, "utf8"));
  } catch {
    return null;
  }
}

export function writeState(p, state) {
  writeFileSync(p.state, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Токен: из state.json, иначе из server.env (стенд поднят, state ещё не записан). */
function devToken(p = paths()) {
  const s = readState(p);
  if (s?.token) return s.token;
  try {
    return /^JARVIS_DEV_TOKEN=(.*)$/m.exec(readFileSync(p.env, "utf8"))?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

async function call(base, method, path, body, headers = {}, timeoutMs = 180_000) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, error: text.slice(0, 500) };
  }
  return { status: r.status, ...json };
}

export const server = (method, path, body, timeoutMs) =>
  call(`http://127.0.0.1:${PORTS.server}`, method, path, body, { "x-jarvis-dev-token": devToken() }, timeoutMs);

export const control = (method, path, body) => call(`http://127.0.0.1:${PORTS.control}`, method, path, body, {}, 10_000);

export async function healthz() {
  const r = await fetch(`http://127.0.0.1:${PORTS.server}/healthz`, { signal: AbortSignal.timeout(3_000) });
  return r.ok ? r.json() : null;
}

/** События журнала фикстур. */
export async function events(query = {}) {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== ""));
  const r = await control("GET", `/events?${qs}`);
  return r.events ?? [];
}

/** Сохранить картинки из result.content в <B>/out; вернуть пути. */
export function saveImages(result, tag = "tool") {
  const p = paths();
  mkdirSync(p.out, { recursive: true });
  const out = [];
  for (const [i, c] of (result?.content ?? []).entries()) {
    if (c.type !== "image") continue;
    const ext = /jpe?g/.test(c.mediaType) ? "jpg" : "png";
    const f = join(p.out, `${tag}-${Date.now()}-${i}.${ext}`);
    writeFileSync(f, Buffer.from(c.data, "base64"));
    out.push(f);
  }
  return out;
}
