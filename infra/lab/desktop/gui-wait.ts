/**
 * wait.for на ВИРТУАЛЬНЫХ часах: каждый опрос продвигает `core.advance(poll)`, реального ожидания нет — 120 «секунд»
 * ожидания стоят миллисекунды. Восемь видов условий, честные исходы как у клиента: таймаут = ok + met:false (не ошибка),
 * «не смог проверить» = unknown:true (≠ «не наступило»), под вуалью визуальные условия помечаются veiled/unknown.
 */
import type { WaitCondition } from "@jarvis/protocol";
import { normPath } from "./core.js";
import type { KindHandler } from "./core.js";
import { sceneLines, monitorRect, pickMonitor } from "./gui-scene.js";
import type { Ctx } from "./gui-model.js";
import { ActionError, toScreenRect } from "./gui-state.js";
import { findNode, fold } from "./gui-tree.js";

export interface WaitOutcome {
  met: boolean;
  elapsedMs: number;
  polls: number;
  detail: string;
  veiled?: boolean;
  gsiState?: "fresh" | "stale" | "none";
  unknown?: boolean;
}

type Check = [met: boolean, detail: string, gsi?: WaitOutcome["gsiState"], unknown?: boolean];
const GSI_FRESH_MS = 10_000;
const GSI_RECENT_MS = 40_000;
const VISUAL = new Set(["ui", "text"]);

const pollFor = (c: WaitCondition): number => (c.kind === "gsi" ? 400 : c.kind === "file" || c.kind === "process" ? 500 : c.kind === "text" ? 1200 : 600);

function validate(c: WaitCondition): void {
  if (c.kind === "window" && !(c.titleContains ?? "").trim() && !(c.process ?? "").trim()) throw new Error("wait_for window: нужен titleContains и/или process");
  if (c.kind === "text" && !c.text.trim()) throw new Error("wait_for text: пустой текст");
  if (c.kind === "file" && !String(c.path ?? "").trim()) throw new Error("wait_for file: пустой path");
  if (c.kind === "process" && (c.pid === undefined || !Number.isInteger(c.pid) || c.pid <= 0) && !String(c.name ?? "").trim()) {
    throw new Error("wait_for process: нужен pid (>0) или name (имя образа, напр. 'ffmpeg.exe')");
  }
}

const dig = (data: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), data);
const sig = (b: Buffer): string => `${b.length}:${b.subarray(0, 64).toString("hex")}:${b.subarray(-64).toString("hex")}`;

export function makeWaiter(dispatch: KindHandler) {
  async function checkOnce(ctx: Ctx, c: WaitCondition): Promise<Check> {
    const { core, st } = ctx;
    switch (c.kind) {
      case "ui": {
        let found = true;
        try {
          findNode(ctx, { role: c.role, name: c.name, nameMode: c.nameMode });
        } catch {
          found = false;
        }
        return [c.gone ? !found : found, found ? "элемент найден" : "элемент не найден"];
      }
      case "window": {
        const t = (c.titleContains ?? "").trim().toLowerCase();
        const p = (c.process ?? "").trim().toLowerCase();
        const hit = [...core.windows.values()].find((w) => (!t || w.title.toLowerCase().includes(t)) && (!p || w.process.toLowerCase().includes(p)));
        return [c.gone ? !hit : Boolean(hit), hit ? `окно «${hit.title}» (${hit.process})` : "окна нет"];
      }
      case "text": {
        const region = c.rect ? toScreenRect(st, c.rect).rect : monitorRect(core, pickMonitor(ctx, c.monitor));
        const seen = sceneLines(ctx, region).map((l) => l.text).join(" ");
        const found = fold(seen).includes(fold(c.text));
        return [c.gone ? !found : found, found ? "текст найден" : `текста нет (видно: «${seen.slice(0, 120)}${seen.length > 120 ? "…" : ""}»)`];
      }
      case "sound": {
        const r = await dispatch({ kind: "system.media", op: "state" }, { commandId: "wait-sound", timeoutMs: 5000 });
        if (!r.ok) return [false, `сенсор звука не ответил: ${r.error?.message ?? "?"}`, undefined, true];
        const playing = Boolean((r.data as { playing?: unknown } | undefined)?.playing);
        return [playing === c.playing, `звук ${playing ? "идёт" : "не идёт"}`];
      }
      case "gsi": {
        const got = st.gsi.get(c.source ?? "default");
        if (!got) return [false, `GSI: источник «${c.source ?? "default"}» ещё ничего не пушил`, "none"];
        const age = core.now() - got.at;
        if (age > GSI_FRESH_MS) return age <= GSI_RECENT_MS ? [c.gone === true, "GSI: источник замолчал (протух) — значение исчезло", "stale"] : [false, "GSI: запись давно протухла — данных нет", "stale"];
        const raw = dig(got.data, c.path);
        const v = raw === undefined ? "" : String(raw);
        const matched = c.equals !== undefined ? v === String(c.equals) : c.contains !== undefined ? v.toLowerCase().includes(String(c.contains).toLowerCase()) : v !== "";
        return [c.gone === true ? !matched : matched, `GSI ${c.path} = «${v.slice(0, 80)}»`, "fresh"];
      }
      case "file": {
        const abs = normPath(/^[A-Za-z]:|^\//u.test(c.path) ? c.path : `${core.fs.home}/${c.path}`);
        const buf = core.fs.files.get(abs);
        if (!buf && !core.fs.dirs.has(abs)) {
          st.fileWatch.delete(abs);
          return [Boolean(c.gone), "файла нет"];
        }
        if (c.gone) return [false, `файл есть (${buf?.length ?? 0} байт)`];
        const size = buf?.length ?? 0;
        const min = c.minBytes ?? 1;
        if (size < min && buf) return [false, `файл есть, но ${size} байт < minBytes ${min}`];
        if ((c.stableMs ?? 0) > 0) {
          const now = core.now();
          const s = buf ? sig(buf) : "dir";
          const prev = st.fileWatch.get(abs);
          if (!prev || prev.sig !== s) {
            st.fileWatch.set(abs, { sig: s, since: now });
            return [false, `файл меняется (${size} байт) — жду стабилизации ${c.stableMs} мс`];
          }
          if (now - prev.since < c.stableMs!) return [false, `файл ${size} байт, не меняется ${now - prev.since} мс из ${c.stableMs}`];
          return [true, `файл ${size} байт, не меняется ≥${c.stableMs} мс`];
        }
        return [true, `файл есть (${size} байт)`];
      }
      case "process": {
        const name = String(c.name ?? "").trim().toLowerCase().replace(/\.exe$/u, "");
        const alive = [...core.windows.values()].some((w) => (c.pid !== undefined ? w.pid === c.pid : w.process.toLowerCase().replace(/\.exe$/u, "") === name));
        const who = c.pid !== undefined ? `pid ${c.pid}` : `«${c.name}»`;
        return [c.gone ? !alive : alive, alive ? `процесс ${who} жив` : `процесса ${who} нет`];
      }
      case "browser":
        // Оценивается на СЕРВЕРЕ через мост расширения; клиент честно «нет» (как настоящий).
        return [false, "browser-условие проверяется на сервере (расширение), не на клиенте"];
      default: {
        const never: never = c;
        throw new ActionError(`wait_for: неизвестное условие ${JSON.stringify(never)}`, "runtime");
      }
    }
  }

  return async function waitFor(ctx: Ctx, cond: WaitCondition, timeoutMs?: number, pollMs?: number): Promise<WaitOutcome> {
    validate(cond);
    const { core, st } = ctx;
    if (cond.kind === "file") st.fileWatch.delete(normPath(/^[A-Za-z]:|^\//u.test(cond.path) ? cond.path : `${core.fs.home}/${cond.path}`));
    const timeout = Math.min(120_000, Math.max(1000, timeoutMs ?? 30_000));
    const poll = Math.max(150, pollMs ?? pollFor(cond));
    const t0 = core.now();
    let polls = 0;
    let sawVeil = false;
    for (;;) {
      polls += 1;
      const veiled = st.drawing;
      if (veiled) sawVeil = true;
      const [met, detail, gsiState, unsure] = await checkOnce(ctx, cond);
      const base = { elapsedMs: core.now() - t0, polls, detail, ...(gsiState ? { gsiState } : {}), ...(veiled ? { veiled: true } : {}) };
      if (met) return { met: true, ...base };
      if (core.now() - t0 + poll > timeout) return { met: false, ...base, ...(unsure || (sawVeil && VISUAL.has(cond.kind)) ? { unknown: true } : {}) };
      core.advance(poll);
    }
  };
}
