/**
 * Умный резолвер + ЧЕСТНЫЙ запуск приложений/игр (§6 app.launch).
 *
 * Зачем: прежний launchApp слал `Start-Process -FilePath <голое имя>` и определял успех по коду
 * выхода обёртки + `setTimeout(1500)` → запускал только то, что в PATH/App Paths, а для игр (Dota и
 * пр.) и сторонних приложений МОЛЧА проваливался ИЛИ рапортовал ЛОЖНЫЙ успех. Корень регрессии
 * «не запускает Доту, но говорит Готово» (ревью 2026-06-18).
 *
 * Подход (концепция «дать инструмент, модель сама делает», БЕЗ хардкода под игры): актуатор —
 * детерминированный резолвер из ИСТОЧНИКОВ ИСТИНЫ ОС + честная проверка факта запуска. Что не
 * резолвится однозначно — честный провал, дальше модель сама (web_search/code_run).
 *
 * Каскад резолва (по убыванию приоритета score): URI-схема / существующий путь → App Paths реестр →
 * Steam-игры (скан appmanifest_*.acf, generic fuzzy с транслитом+Левенштейном, «дота»→steam://
 * rungameid/570) → ярлыки меню Пуск (.lnk) → PATH (Get-Command). Честность: exe запускаем с
 * `-PassThru` (реальный PID) и проверяем, что процесс не умер мгновенно; URI — снимок процессов
 * до/после по имени-подсказке. Никакого ложного успеха по таймауту.
 *
 * PS — чистый ASCII (транслит по char-кодам), цель/режим через ENV (анти-инъекция). String.raw —
 * чтобы бэкслеши путей не съелись JS-эскейпами; в скрипте нет ни backtick, ни ${...}.
 */
import { spawn } from "node:child_process";
import { createLogger } from "@jarvis/shared";

const log = createLogger("actuator:launch");

export interface SmartLaunchResult {
  /** Что реально ушло в ОС (exe-путь или URI) — для ActionResult.data. */
  resolved: string;
  kind: string; // exe | uri | path
  display: string; // человекочитаемое имя кандидата
  source: string; // откуда нашли (AppPaths/Steam/StartMenu/PATH/uri/path)
  pid?: number;
}

/** Честная ошибка запуска: not_found (не нашли что запускать) | launch_failed (нашли, но не стартовало). */
export class LaunchError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "launch_failed",
  ) {
    super(message);
    this.name = "LaunchError";
  }
}

// Проверенный вживую (dry-run на реальной машине) каскадный резолвер + честный запуск.
const LAUNCH_PS = String.raw`
$ErrorActionPreference='Stop'
$vals=@('a','b','v','g','d','e','zh','z','i','y','k','l','m','n','o','p','r','s','t','u','f','h','c','ch','sh','sch','','y','','e','yu','ya')
$translit=@{}
for($i=0;$i -lt 32;$i++){ $translit[[char](0x0430+$i)]=$vals[$i] }
$translit[[char]0x0451]='e'
function Norm($s){ $o=''; foreach($ch in ([string]$s).ToLower().ToCharArray()){ if($translit.ContainsKey($ch)){$o+=$translit[$ch]}else{$o+=[string]$ch} }; ($o -replace '[^a-z0-9]','') }
function Lev($a,$b){ $n=$a.Length;$m=$b.Length; if($n -eq 0){return $m}; if($m -eq 0){return $n}; $d=New-Object 'int[,]' ($n+1),($m+1); for($i=0;$i -le $n;$i++){$d[$i,0]=$i}; for($j=0;$j -le $m;$j++){$d[0,$j]=$j}; for($i=1;$i -le $n;$i++){ for($j=1;$j -le $m;$j++){ $c=[int]($a[$i-1] -ne $b[$j-1]); $x=$d[($i-1),$j]+1;$y=$d[$i,($j-1)]+1;$z=$d[($i-1),($j-1)]+$c; $d[$i,$j]=[Math]::Min([Math]::Min($x,$y),$z) } }; return $d[$n,$m] }
$q=$env:JARVIS_Q
if(-not $q){ Write-Output 'RESOLVE:FAIL reason=empty'; exit 1 }
$qn=Norm $q
function Cand($target,$kind,$display,$source,$hint,$score){ [pscustomobject]@{ target=$target;kind=$kind;display=$display;source=$source;hint=$hint;score=$score } }
$cands=@()
$junk='redistributable|runtime|proton|steamworks common|dedicated server|sdk|soundtrack'
if(Test-Path -LiteralPath $q -EA SilentlyContinue){ $leaf=[IO.Path]::GetFileNameWithoutExtension($q); $cands+=Cand $q 'exe' $q 'path' $leaf 100 }
elseif($q -match '^[a-z][a-z0-9+.\-]+:'){ $cands+=Cand $q 'uri' $q 'uri' '' 100 }
else {
  $appPathBases='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths'
  foreach($base in $appPathBases){
    $exact=Join-Path $base ($q+'.exe')
    if(Test-Path $exact){ $p=(Get-ItemProperty $exact).'(default)'; if($p){ $p=$p.Trim('"'); $cands+=Cand $p 'exe' ([IO.Path]::GetFileName($p)) 'AppPaths' ([IO.Path]::GetFileNameWithoutExtension($p)) 100 } }
  }
  $sp=(Get-ItemProperty 'HKCU:\Software\Valve\Steam' -EA SilentlyContinue).SteamPath
  if($sp){ $sp=$sp -replace '/','\'; $libs=@($sp)
    $vdf=Join-Path $sp 'steamapps\libraryfolders.vdf'
    if(Test-Path $vdf){ (Get-Content $vdf)|Select-String '"path"\s+"(.+?)"'|ForEach-Object{ $libs+=($_.Matches.Groups[1].Value -replace '\\\\','\') } }
    $seen=@{}
    foreach($l in ($libs|Select-Object -Unique)){
      $sa=Join-Path $l 'steamapps'; if(-not(Test-Path $sa)){continue}
      foreach($acf in Get-ChildItem $sa -Filter 'appmanifest_*.acf' -EA SilentlyContinue){
        $t=Get-Content $acf.FullName -Raw; $id=$null;$nm=$null
        if($t -match '"appid"\s+"(\d+)"'){$id=$Matches[1]}
        if($t -match '"name"\s+"(.+?)"'){$nm=$Matches[1]}
        if(-not($id -and $nm)){continue}; if($seen.ContainsKey($id)){continue}; $seen[$id]=$true
        if($nm -match $junk){continue}
        $gn=Norm $nm; $dist=Lev $qn $gn
        if($gn.Contains($qn) -or $qn.Contains($gn)){ $dist=0 }
        if($dist -le 2){ $cands+=Cand ("steam://rungameid/$id") 'uri' $nm "Steam(d=$dist)" '' (86-$dist*8) }
      }
    }
  }
  $menus="$env:ProgramData\Microsoft\Windows\Start Menu\Programs","$env:AppData\Microsoft\Windows\Start Menu\Programs"
  $wsh=New-Object -ComObject WScript.Shell
  foreach($lnk in (Get-ChildItem $menus -Recurse -Filter '*.lnk' -EA SilentlyContinue)){
    $bn=Norm $lnk.BaseName; if(-not $bn){continue}
    $d=Lev $qn $bn; if($bn.Contains($qn) -or $qn.Contains($bn)){ $d=0 }
    if($d -le 1){ $tp=$wsh.CreateShortcut($lnk.FullName).TargetPath; if($tp -and (Test-Path $tp)){ $cands+=Cand $tp 'exe' $lnk.BaseName "StartMenu(d=$d)" ([IO.Path]::GetFileNameWithoutExtension($tp)) (90-$d*10) } }
  }
  $w=(Get-Command -Name $q -CommandType Application -EA SilentlyContinue | Select-Object -First 1).Source
  if($w){ $cands+=Cand $w 'exe' ([IO.Path]::GetFileName($w)) 'PATH' ([IO.Path]::GetFileNameWithoutExtension($w)) 95 }
}
if($cands.Count -eq 0){ Write-Output ('RESOLVE:FAIL reason=not-found q='+$q); exit 1 }
$best=($cands | Sort-Object -Property @{Expression='score';Descending=$true},@{Expression={$_.target.Length};Descending=$false})[0]
if($env:JARVIS_DRYRUN -eq '1'){ Write-Output ("RESOLVE:OK target={0} | kind={1} | display={2} | source={3}" -f $best.target,$best.kind,$best.display,$best.source); exit 0 }
$waitMs=[int]($env:JARVIS_WAIT_MS); if($waitMs -le 0){ $waitMs=1500 }
try {
  if($best.kind -eq 'exe'){
    $p=Start-Process -FilePath $best.target -PassThru
    if(-not $p){ Write-Output 'LAUNCH:FAIL reason=no-process'; exit 1 }
    Start-Sleep -Milliseconds $waitMs
    if(Get-Process -Id $p.Id -EA SilentlyContinue){ Write-Output ("LAUNCH:OK target={0} | kind=exe | pid={1} | display={2} | source={3}" -f $best.target,$p.Id,$best.display,$best.source) }
    else {
      # Процесс вышел. Для СТАБ-ЛОНЧЕРОВ (UWP/Store-приложения: Калькулятор/calc, Камера, Фото и т.п.)
      # exe МГНОВЕННО отдаёт управление реальному приложению и выходит с кодом 0 — это УСПЕШНЫЙ хэндофф,
      # а не провал (баг ложного негатива: приложение открылось, а Джарвис рапортовал «не вышло»).
      # Ненулевой/нечитаемый код выхода → реальный провал запуска (честно).
      $ec=$null; try{ $ec=$p.ExitCode }catch{}
      if($ec -eq 0){ Write-Output ("LAUNCH:OK target={0} | kind=exe | pid={1} | display={2} | source={3}" -f $best.target,$p.Id,$best.display,$best.source) }
      else { Write-Output ("LAUNCH:FAIL reason=process-exited-immediately exit={0}" -f $ec) }
    }
  } else {
    $before=0; if($best.hint){ $before=@(Get-Process -Name $best.hint -EA SilentlyContinue).Count }
    Start-Process -FilePath $best.target
    if(-not $best.hint){ Write-Output ("LAUNCH:OK target={0} | kind={1} | display={2} | source={3}" -f $best.target,$best.kind,$best.display,$best.source); exit 0 }
    $deadline=(Get-Date).AddMilliseconds([Math]::Max($waitMs,8000))
    do { Start-Sleep -Milliseconds 400; if(@(Get-Process -Name $best.hint -EA SilentlyContinue).Count -gt $before){ Write-Output ("LAUNCH:OK target={0} | kind={1} | display={2} | source={3}" -f $best.target,$best.kind,$best.display,$best.source); exit 0 } } while((Get-Date) -lt $deadline)
    Write-Output 'LAUNCH:FAIL reason=process-not-appeared'
  }
} catch { Write-Output ('LAUNCH:FAIL reason='+($_.Exception.Message -replace '[\r\n]',' ')); exit 1 }
`;

/** Распарсить строку маркера `KEY=val | KEY=val` в словарь. */
export function parseMarker(line: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const part of line.split("|")) {
    const m = part.match(/^\s*(\w+)=([\s\S]*?)\s*$/);
    if (m) kv[m[1]!] = m[2]!.trim();
  }
  return kv;
}

/**
 * Умный честный запуск. Резолвит цель из источников истины ОС и запускает с проверкой факта старта.
 * dryRun — только резолв (для тестов/диагностики), приложение не запускается. Бросает LaunchError при
 * провале резолва/запуска (никакого ложного успеха).
 */
export async function smartLaunch(
  query: string,
  opts: { dryRun?: boolean; waitMs?: number } = {},
): Promise<SmartLaunchResult> {
  return new Promise<SmartLaunchResult>((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", LAUNCH_PS],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          JARVIS_Q: query,
          JARVIS_DRYRUN: opts.dryRun ? "1" : "0",
          JARVIS_WAIT_MS: String(opts.waitMs ?? 1500),
        },
      },
    );
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (out += d));
    child.on("error", (e) => reject(e));
    // Жёсткий потолок: НЕ резолвим в успех по таймауту (в этом был баг) — таймаут = провал.
    const hard = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* уже завершён */
      }
      reject(new LaunchError(`лаунчер не ответил вовремя для «${query}»`, "launch_failed"));
    }, 25_000);
    if (typeof hard === "object" && "unref" in hard) hard.unref?.();

    child.on("exit", () => {
      clearTimeout(hard);
      const lines = out.split(/\r?\n/);
      const okLine = lines.find((l) => /^(LAUNCH|RESOLVE):OK\b/.test(l));
      if (okLine) {
        const kv = parseMarker(okLine.replace(/^(LAUNCH|RESOLVE):OK\s*/, ""));
        log.info(`launch "${query}" → [${kv.source}] ${kv.display} (${kv.kind}:${kv.target})`);
        resolve({
          resolved: kv.target ?? query,
          kind: kv.kind ?? "",
          display: kv.display ?? query,
          source: kv.source ?? "",
          pid: kv.pid ? Number.parseInt(kv.pid, 10) : undefined,
        });
        return;
      }
      const failLine = lines.find((l) => /:FAIL\b/.test(l)) ?? "";
      const reason = failLine.match(/reason=([\s\S]+)$/)?.[1]?.trim() ?? "не удалось запустить";
      const code = /not-found/.test(failLine) ? "not_found" : "launch_failed";
      log.warn(`launch "${query}" провал: ${reason}`);
      reject(new LaunchError(`не удалось запустить «${query}»: ${reason}`, code));
    });
  });
}
