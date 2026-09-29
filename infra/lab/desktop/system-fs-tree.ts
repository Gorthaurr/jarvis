/**
 * fs.list и fs.search над виртуальной ФС — порты `listDir`/`search` из fs.ts. list, как и у клиента, БЕЗ рельс (дефект low из
 * карты — воспроизведён намеренно); search: корень через assertReadable, секретные записи пропускаются, каталог совпадает по
 * имени, отчёт о полноте (exhausted/stopReason/note) — из fs-search-report.ts клиента. Ссылок/junction в виртуальной ФС нет →
 * skippedLinks всегда 0; время обхода — по ВИРТУАЛЬНЫМ часам (обход синхронный, они стоят), так что time_budget возможен
 * только при budgetMs=0.
 */
import { extname } from "node:path";
import { cutText } from "@jarvis/shared";
import { textForSearchDetailed } from "../../../apps/client/main/actuators/fs-content.js";
import { DEFAULT_IGNORED_DIRS, EMPTY_GAPS, type SearchGaps, type SearchMatch, type SearchOptions, type SearchResult, type SearchStopReason, isExhausted, searchBudgetMs, searchNote, searchScanCap } from "../../../apps/client/main/actuators/fs-search-report.js";
import type { DesktopCore } from "./core.js";
import { guardRead } from "./vfs-guard.js";
import { type VIndex, buildIndex, expandPath, lower, readdir, tryStat, winPath } from "./vfs.js";
import { isSecretPathFast } from "../../../apps/client/main/actuators/self-guard.js";

const MAX_LIST_ENTRIES = 5000;
const MAX_SEARCH_RESULTS = 200;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

export interface FsEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "other";
  size: number;
}

export function listTree(core: DesktopCore, path: string, recursive = false): { path: string; entries: FsEntry[]; truncated: boolean } {
  const abs = expandPath(core, path);
  const idx = buildIndex(core);
  const entries: FsEntry[] = [];
  let truncated = false;
  const walk = (dir: string): void => {
    for (const d of readdir(core, dir, idx)) {
      if (entries.length >= MAX_LIST_ENTRIES) { truncated = true; return; }
      entries.push({ name: d.name, path: winPath(d.p), type: d.kind, size: d.kind === "file" ? d.size : 0 });
      if (recursive && d.kind === "dir") walk(d.p);
    }
  };
  walk(abs);
  return { path: winPath(abs), entries, truncated };
}

function rootProblem(core: DesktopCore, abs: string, idx: VIndex): string | null {
  const e = tryStat(core, abs, idx);
  if (!e) return "не существует";
  return e.kind === "dir" ? null : "не каталог (это файл)";
}

export function searchTree(core: DesktopCore, root: string, query: string, inContent = false, maxResults = 50, opts?: SearchOptions): SearchResult {
  const absRoot = expandPath(core, root);
  guardRead(absRoot);
  const idx = buildIndex(core);
  const bad = rootProblem(core, absRoot, idx);
  if (bad) throw new Error(`fs.search: корень «${winPath(absRoot)}» ${bad}.`);
  const scanCap = searchScanCap(opts);
  const budgetMs = searchBudgetMs(opts);
  const limit = Math.min(Math.max(1, maxResults), MAX_SEARCH_RESULTS);
  const needle = query.toLowerCase();
  const matches: SearchMatch[] = [];
  const gaps: SearchGaps = { ...EMPTY_GAPS };
  const ignore = new Set((opts?.ignore ?? DEFAULT_IGNORED_DIRS).map((s) => String(s).toLowerCase()));
  const ignoredNames = new Map<string, string>();
  let ignoredDirs = 0;
  let recodedFiles = 0;
  let files = 0;
  let stopReason: SearchStopReason | undefined;
  const startedAt = core.now();
  const capHit = (): boolean => {
    if (matches.length >= limit) { stopReason ??= "max_results"; return true; }
    if (files >= scanCap) { stopReason ??= "scan_cap"; return true; }
    if (core.now() - startedAt >= budgetMs) { stopReason ??= "time_budget"; return true; }
    return false;
  };
  const walk = (dir: string): void => {
    if (capHit()) return;
    for (const d of idx.kids.get(lower(dir)) ?? []) {
      if (capHit()) return;
      const full = winPath(d.p);
      if (d.kind === "dir") {
        if (!inContent && d.name.toLowerCase().includes(needle) && !isSecretPathFast(d.p) && matches.length < limit) matches.push({ path: full, kind: "dir" });
        if (ignore.has(d.name.toLowerCase())) {
          ignoredDirs += 1;
          if (!ignoredNames.has(d.name.toLowerCase())) ignoredNames.set(d.name.toLowerCase(), d.name);
          continue;
        }
        walk(d.p);
        continue;
      }
      files += 1;
      if (isSecretPathFast(d.p)) continue;
      if (!inContent) {
        if (d.name.toLowerCase().includes(needle)) matches.push({ path: full });
        continue;
      }
      if (d.size > MAX_CONTENT_BYTES) { gaps.oversizedFiles += 1; continue; }
      const decoded = textForSearchDetailed(core.fs.files.get(d.p) ?? Buffer.alloc(0), extname(d.name));
      if (decoded === null) continue;
      if (decoded.encoding === "cp1251") recodedFiles += 1;
      else if (decoded.text.includes("�")) gaps.undecodedFiles += 1;
      const lines = decoded.text.split(/\r?\n/);
      const i = lines.findIndex((l) => l.toLowerCase().includes(needle));
      if (i >= 0) matches.push({ path: full, line: i + 1, preview: cutText(lines[i]!, 200) });
    }
  };
  const start = tryStat(core, absRoot, idx)!;
  walk(start.p);
  const exhausted = isExhausted(stopReason, gaps);
  const ignoredList = [...ignoredNames.values()].slice(0, 12);
  const note = searchNote(stopReason, { scanCap, limit, budgetMs, scanned: files, recodedFiles, ignoredDirs, ignoredNames: ignoredList, ignoredDistinct: ignoredNames.size, customIgnore: opts?.ignore !== undefined, ...gaps });
  return { truncated: stopReason !== undefined, ...(stopReason ? { stopReason } : {}), scannedFiles: files, recodedFiles, exhausted, ignoredDirs, ignoredNames: ignoredList, ...gaps, ...(note ? { note } : {}), matches };
}
