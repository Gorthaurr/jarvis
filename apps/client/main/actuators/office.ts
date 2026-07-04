/**
 * Office-актуатор (§6): живые Word/Excel через COM-автоматизацию.
 *
 * В отличие от code.run (CLM блокирует New-Object COM), это первоклассный путь к
 * приложениям Office. Скрипты PowerShell — ФИКСИРОВАННЫЕ константы; данные (путь,
 * значения) передаются через temp-JSON (`$env:JARVIS_OFFICE_ARGS`) и читаются
 * `ConvertFrom-Json` — НЕ интерполируются в тело скрипта (анти-инъекция, ср. apps.focus).
 *
 * Headless (Visible=$false), DisplayAlerts=$false, в finally — Quit + ReleaseComObject,
 * таймаут с kill (COM умеет зависать). Нет Office → понятная ошибка (мозг откатится на
 * файловый путь code_run + openpyxl/python-docx).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ActionCommand } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import { expandPath } from "./fs.js";
import { assertReadable, assertWritable } from "./self-guard.js";

const log = createLogger("actuator:office");

const RESULT_MARKER = "JARVIS_OFFICE_RESULT ";
const TIMEOUT_MS = 30_000;

type ExcelCmd = Extract<ActionCommand, { kind: "office.excel" }>;
type WordCmd = Extract<ActionCommand, { kind: "office.word" }>;

/** Фиксированный COM-скрипт Excel: читает аргументы из JSON, выполняет op, печатает результат. */
export const EXCEL_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$a = Get-Content $env:JARVIS_OFFICE_ARGS -Raw -Encoding UTF8 | ConvertFrom-Json
$excel=$null;$wb=$null
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible=$false; $excel.DisplayAlerts=$false
  try { $excel.AutomationSecurity = 3 } catch {} # подавить макро-промпты
  $exists = Test-Path -LiteralPath $a.path
  # Retry-открытие: файл может быть кратко занят предыдущим экземпляром (COM освобождает асинхронно).
  # $null слева — правило PowerShell для COM-объектов (иначе -eq может вести себя как фильтр).
  for ($try=0; $try -lt 6 -and $null -eq $wb; $try++) {
    try { if ($exists) { $wb = $excel.Workbooks.Open($a.path) } else { $wb = $excel.Workbooks.Add() } }
    catch { if ($try -eq 5) { throw }; Start-Sleep -Milliseconds 500 }
  }
  if ($a.sheet) { try { $ws = $wb.Worksheets.Item($a.sheet) } catch { $ws = $wb.Worksheets.Add(); $ws.Name = $a.sheet } }
  else { $ws = $wb.Worksheets.Item(1) }
  $result = @{ ok = $true; op = $a.op }
  switch ($a.op) {
    'read' {
      if ($a.range) { $rng = $ws.Range($a.range) } else { $rng = $ws.UsedRange }
      $rows = @()
      for ($r=1; $r -le $rng.Rows.Count; $r++) {
        $cols = @()
        for ($c=1; $c -le $rng.Columns.Count; $c++) { $cols += ,([string]$rng.Cells.Item($r,$c).Value2) }
        $rows += ,$cols
      }
      $result.values = $rows
    }
    'write_cell' { $ws.Range($a.cell).Value2 = $a.value; $result.cell = $a.cell }
    'append_row' {
      $used = $ws.UsedRange
      $empty = ($used.Rows.Count -eq 1 -and [string]::IsNullOrEmpty([string]$ws.Cells.Item(1,1).Value2))
      $row = if ($empty) { 1 } else { $used.Rows.Count + 1 }
      for ($i=0; $i -lt $a.row.Count; $i++) { $ws.Cells.Item($row, $i+1).Value2 = $a.row[$i] }
      $result.row = $row
    }
  }
  if ($a.op -ne 'read') { if ($exists) { $wb.Save() } else { $wb.SaveAs($a.path, 51) } }
  Write-Output ("JARVIS_OFFICE_RESULT " + ($result | ConvertTo-Json -Depth 6 -Compress))
} catch {
  Write-Output ("JARVIS_OFFICE_RESULT " + (@{ ok=$false; error=$_.Exception.Message } | ConvertTo-Json -Compress))
} finally {
  if ($wb) { try { $wb.Close($false) | Out-Null } catch {} }
  if ($excel) { try { $excel.Quit() } catch {} }
  if ($wb) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($wb) }
  if ($excel) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel) }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
`;

/** Фиксированный COM-скрипт Word. */
export const WORD_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$a = Get-Content $env:JARVIS_OFFICE_ARGS -Raw -Encoding UTF8 | ConvertFrom-Json
$word=$null;$doc=$null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible=$false
  $exists = Test-Path -LiteralPath $a.path
  for ($try=0; $try -lt 6 -and $null -eq $doc; $try++) {
    try { if ($exists) { $doc = $word.Documents.Open($a.path) } else { $doc = $word.Documents.Add() } }
    catch { if ($try -eq 5) { throw }; Start-Sleep -Milliseconds 500 }
  }
  $result = @{ ok = $true; op = $a.op }
  switch ($a.op) {
    'read'   { $result.text = $doc.Content.Text }
    'write'  { $doc.Content.Text = [string]$a.text }
    'append' { $doc.Content.InsertAfter([char]13 + [string]$a.text) }
  }
  if ($a.op -ne 'read') { if ($exists) { $doc.Save() } else { $doc.SaveAs([ref]$a.path, [ref]16) } }
  Write-Output ("JARVIS_OFFICE_RESULT " + ($result | ConvertTo-Json -Depth 4 -Compress))
} catch {
  Write-Output ("JARVIS_OFFICE_RESULT " + (@{ ok=$false; error=$_.Exception.Message } | ConvertTo-Json -Compress))
} finally {
  if ($doc) { try { $doc.Close($false) | Out-Null } catch {} }
  if ($word) { try { $word.Quit() } catch {} }
  if ($doc) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc) }
  if ($word) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word) }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
`;

/** Подготовить аргументы (раскрыть путь) для передачи в COM-скрипт. */
export function buildExcelArgs(cmd: ExcelCmd): Record<string, unknown> {
  return { op: cmd.op, path: expandPath(cmd.path), sheet: cmd.sheet ?? null, range: cmd.range ?? null, cell: cmd.cell ?? null, value: cmd.value ?? null, row: cmd.row ?? [] };
}

export function buildWordArgs(cmd: WordCmd): Record<string, unknown> {
  return { op: cmd.op, path: expandPath(cmd.path), text: cmd.text ?? "" };
}

/**
 * §0/§sec: до любого COM — денилист секретов (тот же guard, что в fs.ts). op=read → assertReadable
 * (не читаем .env-секреты в контекст), мутирующие op → assertWritable (не пишем в node_modules/.env/
 * бинарь). Путь к секрету → честная ошибка ДО запуска Office.
 */
function assertOfficePath(op: string, absPath: string): void {
  if (op === "read") assertReadable(absPath);
  else assertWritable(absPath); // write/write_cell/append/append_row
}

/**
 * M9 (конкурентность): сериализуем вызовы к ОДНОМУ файлу. Два append_row на один .xlsx через COM
 * гонятся (оба читают UsedRange до записи → теряют строку). Цепочка промисов per-normalized-path;
 * запись в хвост цепочки атомарна (single-threaded event loop), запись стирается после опустошения.
 */
const pathLocks = new Map<string, Promise<unknown>>();

function withPathLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(absPath).toLowerCase();
  const prev = pathLocks.get(key) ?? Promise.resolve();
  // цепляемся за хвост (игнорируя исход предыдущего — свой вызов не должен падать из-за чужого)
  const run = prev.catch(() => undefined).then(fn);
  pathLocks.set(key, run);
  // подчищаем запись, если мы всё ещё последний в цепочке (иначе новый вызов уже её перезаписал)
  const cleanup = (): void => {
    if (pathLocks.get(key) === run) pathLocks.delete(key);
  };
  run.then(cleanup, cleanup);
  return run;
}

export async function runExcel(cmd: ExcelCmd): Promise<unknown> {
  const args = buildExcelArgs(cmd);
  assertOfficePath(cmd.op, args.path as string);
  return withPathLock(args.path as string, () => runOffice(EXCEL_SCRIPT, args, "EXCEL.EXE"));
}

export async function runWord(cmd: WordCmd): Promise<unknown> {
  const args = buildWordArgs(cmd);
  assertOfficePath(cmd.op, args.path as string);
  return withPathLock(args.path as string, () => runOffice(WORD_SCRIPT, args, "WINWORD.EXE"));
}

async function runOffice(script: string, args: Record<string, unknown>, officeImage: string): Promise<unknown> {
  const tmp = join(tmpdir(), `jarvis-office-${randomUUID()}.json`); // уникально на конкурентные вызовы
  await fsp.writeFile(tmp, JSON.stringify(args), "utf8");
  log.info("office COM", { op: args.op, path: args.path });
  try {
    const out = await runPowershell(script, { JARVIS_OFFICE_ARGS: tmp }, officeImage);
    const line = out.split(/\r?\n/).find((l) => l.startsWith(RESULT_MARKER));
    if (!line) throw new Error("Office COM не вернул результат (возможно, Office не установлен)");
    const res = JSON.parse(line.slice(RESULT_MARKER.length)) as { ok: boolean; error?: string };
    if (!res.ok) throw new Error(res.error ?? "Office COM ошибка");
    return res;
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}

function runPowershell(script: string, env: Record<string, string>, officeImage: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { if (out.length < 4_000_000) out += d; });
    child.stderr.on("data", (d: string) => { err += String(d); });
    const timer = setTimeout(() => {
      // M9: SIGKILL по powershell НЕ убивает порождённый headless-сервер Office (EXCEL/WINWORD),
      // висящий по COM. taskkill /T убивает дерево процессов powershell целиком; затем целевым
      // ударом снимаем ТОЛЬКО невидимый (headless) экземпляр Office — чтобы не тронуть окна юзера.
      killOfficeTree(child.pid, officeImage);
      child.kill("SIGKILL");
      reject(new Error("Office COM таймаут (зависание)"));
    }, TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (out.includes(RESULT_MARKER)) resolve(out); // результат есть даже при ненулевом коде
      else if (code === 0) resolve(out);
      else reject(new Error(`powershell код ${code}${err ? `: ${err.slice(0, 200)}` : ""}`));
    });
  });
}

/**
 * Убить зависшее дерево COM-вызова по таймауту. (1) taskkill /T /F по PID powershell — снимает всё,
 * что powershell породил. (2) Осиротевший headless-сервер Office (Visible=$false) COM-протоколом НЕ
 * является потомком powershell → отдельно снимаем ТОЛЬКО невидимые экземпляры нужного образа
 * (фильтр по свойству MainWindowHandle=0), чтобы НЕ закрыть открытые пользователем документы.
 */
function killOfficeTree(pid: number | undefined, officeImage: string): void {
  if (pid !== undefined) {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
  }
  // Снять только headless-экземпляры (без видимого окна) — щадим документы юзера.
  const ps = `Get-Process -Name '${officeImage.replace(/\.exe$/i, "")}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -eq 0 } | Stop-Process -Force -ErrorAction SilentlyContinue`;
  spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
}
