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
 * `-PassThru` (реальный PID) и проверяем, что процесс не умер мгновенно. Никакого ложного успеха
 * по таймауту.
 *
 * 🔴 СВЕРКА ЗАПУСКА ИГРЫ ПО URI (живой дефект 2026-09-01, ежедневная ложь): ветка URI без подсказки
 * печатала LAUNCH:OK СРАЗУ после Start-Process — то есть `steam://rungameid/<любой мусор>` ВСЕГДА
 * рапортовал успех. У URI нет кода возврата приложения: обработчик схемы (Steam) принимает любой
 * appid, включая несуществующий, и молчит. Теперь для Steam-игры исход СВЕРЯЕТСЯ по двум реальным
 * признакам: (1) процесс из папки установки (appmanifest_<appid>.acf → installdir → *.exe) и
 * (2) `HKCU\Software\Valve\Steam\RunningAppID` (Steam сам пишет туда appid идущей игры). Ни один не
 * подтвердился за отведённое время → ЧЕСТНЫЙ провал. Прочие URI (ms-settings:, https:, tg:) сверять
 * нечем — они помечаются verified=handoff («ОС приняла обработчик»), и результат прямо говорит, что
 * факт открытия не подтверждён (закон: декларация обязана совпадать с поведением).
 *
 * Env-подмены границы ОС (нужны, чтобы гарды проверялись НАСТОЯЩИМ прогоном, а не грепом по коду):
 * JARVIS_START_MENU_DIRS, JARVIS_STEAM_ROOT, JARVIS_STEAM_REG_KEY, JARVIS_STEAM_WAIT_MS,
 * JARVIS_LAUNCH_NO_EXEC=1 (не звать Start-Process). Ложный успех ими получить НЕЛЬЗЯ: сверка
 * исхода они не отключают — без признаков запуска будет честный провал.
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
  /**
   * ЧЕМ подтверждён запуск: process (живой процесс) | appid / appid-already (Steam RunningAppID) |
   * handoff (ОС приняла обработчик URI/стаб-лончер — факт запуска НЕ наблюдался). Отличать handoff
   * от остального обязательно: иначе «принял команду» снова выдаётся за «запустил».
   */
  verified?: string;
  /** dry-run: appid Steam-игры и имена exe из папки установки (диагностика резолва). */
  appid?: string;
  hints?: string;
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
# Имена ярлыков бывают кириллическими: без этого PS отдаёт их в OEM-кодировке, Node читает как
# UTF-8 и в лог/модель уезжают кракозябры («Деинсталлировать Telegram» → нечитаемый мусор).
try { [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false } catch {}
$vals=@('a','b','v','g','d','e','zh','z','i','y','k','l','m','n','o','p','r','s','t','u','f','h','c','ch','sh','sch','','y','','e','yu','ya')
$translit=@{}
for($i=0;$i -lt 32;$i++){ $translit[[char](0x0430+$i)]=$vals[$i] }
$translit[[char]0x0451]='e'
function Norm($s){ $o=''; foreach($ch in ([string]$s).ToLower().ToCharArray()){ if($translit.ContainsKey($ch)){$o+=$translit[$ch]}else{$o+=[string]$ch} }; ($o -replace '[^a-z0-9]','') }
function Lev($a,$b){ $n=$a.Length;$m=$b.Length; if($n -eq 0){return $m}; if($m -eq 0){return $n}; $d=New-Object 'int[,]' ($n+1),($m+1); for($i=0;$i -le $n;$i++){$d[$i,0]=$i}; for($j=0;$j -le $m;$j++){$d[0,$j]=$j}; for($i=1;$i -le $n;$i++){ for($j=1;$j -le $m;$j++){ $c=[int]($a[$i-1] -ne $b[$j-1]); $x=$d[($i-1),$j]+1;$y=$d[$i,($j-1)]+1;$z=$d[($i-1),($j-1)]+$c; $d[$i,$j]=[Math]::Min([Math]::Min($x,$y),$z) } }; return $d[$n,$m] }
$q=$env:JARVIS_Q
if(-not $q){ Write-Output 'RESOLVE:FAIL reason=empty'; exit 1 }
$qn=Norm $q
function Cand($target,$kind,$display,$source,$hint,$score,$appid){ [pscustomobject]@{ target=$target;kind=$kind;display=$display;source=$source;hint=$hint;score=$score;appid=$appid } }
$cands=@()
# Библиотеки Steam (корень + libraryfolders.vdf). JARVIS_STEAM_ROOT подменяет корень — так сверка
# запуска игры проверяется настоящим прогоном на временной библиотеке, без установленной игры.
function SteamLibs(){
  $sp=$env:JARVIS_STEAM_ROOT
  if(-not $sp){ $sp=(Get-ItemProperty 'HKCU:\Software\Valve\Steam' -EA SilentlyContinue).SteamPath }
  if(-not $sp){ return @() }
  $sp=$sp -replace '/','\'
  $libs=@($sp)
  $vdf=Join-Path $sp 'steamapps\libraryfolders.vdf'
  if(Test-Path -LiteralPath $vdf){ (Get-Content -LiteralPath $vdf)|Select-String '"path"\s+"(.+?)"'|ForEach-Object{ $libs+=($_.Matches.Groups[1].Value -replace '\\\\','\') } }
  return @($libs|Select-Object -Unique)
}
# Служебные exe в папке игры: они не доказывают запуск ИГРЫ (а вылет краш-репортера доказывал бы обратное).
$exeJunk='^unins|^setup|^install|crashhandler|crashreport|vcredist|dxsetup|directx|dotnetfx|redist|^touchup'
# ПУТЬ К ИСПОЛНЯЕМОМУ ИЗ МАНИФЕСТА: appmanifest_<appid>.acf (VDF) -> "installdir" -> steamapps\common\<dir>\*.exe.
# Глубина 3 покрывает типовую раскладку (game\bin\win64\dota2.exe, Binaries\Win64\X.exe); имена -> подсказки
# для Get-Process. Манифеста/папки нет -> пусто, и сверка идёт вторым признаком (RunningAppID).
function SteamGameHints($appid){
  if(-not $appid){ return @() }
  foreach($l in (SteamLibs)){
    $acf=Join-Path $l ('steamapps\appmanifest_'+$appid+'.acf')
    if(-not(Test-Path -LiteralPath $acf)){ continue }
    $t=Get-Content -LiteralPath $acf -Raw
    if(-not($t -match '"installdir"\s+"(.+?)"')){ continue }
    $dir=Join-Path $l ('steamapps\common\'+$Matches[1])
    if(-not(Test-Path -LiteralPath $dir)){ continue }
    $ex=@(Get-ChildItem -LiteralPath $dir -Recurse -Depth 3 -Filter '*.exe' -EA SilentlyContinue | ForEach-Object { $_.BaseName } | Where-Object { $_ -notmatch $exeJunk })
    return @($ex|Select-Object -Unique|Select-Object -First 6)
  }
  return @()
}
# appid ИДУЩЕЙ игры — его пишет сам Steam. Единственный признак, работающий и без найденного exe.
function SteamRunningAppId(){
  $k=$env:JARVIS_STEAM_REG_KEY; if(-not $k){ $k='HKCU:\Software\Valve\Steam' }
  $v=(Get-ItemProperty -Path $k -EA SilentlyContinue).RunningAppID
  if($null -eq $v){ return '' }
  return ([string]$v).Trim()
}
# Один снимок процессов на тик (а не Get-Process на каждое имя): поллинг 12с иначе съедал бы секунды CPU.
function CountProcs($names){
  if(-not $names -or @($names).Count -eq 0){ return 0 }
  return @(Get-Process -EA SilentlyContinue | Where-Object { $names -contains $_.ProcessName }).Count
}
$junk='redistributable|runtime|proton|steamworks common|dedicated server|sdk|soundtrack'
# 🔴 БЕЗОПАСНОСТЬ (живой инцидент 2026-09-01): на «открой Telegram» резолвер выбрал ярлык
# «Деинсталлировать Telegram» -> unins000.exe и ЗАПУСТИЛ ДЕИНСТАЛЛЯТОР. Причина: правило
# Contains обнуляло дистанцию любому имени, СОДЕРЖАЩЕМУ запрос, а тай-брейк по длине пути у
# Telegram.exe и unins000.exe совпадал (12 символов) -> победил случайный порядок обхода.
# Рубеж 1: цель-деинсталлятор НИКОГДА не запускается по просьбе «открой/запусти» (жёсткий отказ).
$badTarget='^unins|^uninstall|^uninst|uninstall|unins0'
# Рубеж 2: служебные ярлыки рядом с приложением (удалить/справка/сайт/README) — не «приложение».
# Список по НОРМАЛИЗОВАННОМУ (транслитерированному) имени, поэтому строки ASCII-only.
$junkName='uninstall|uninst|deinstall|udalit|remove|repair|izmenit|vosstanovit|spravka|readme|documentation|dokumentaci|website|sayt|support|podderzhka|changelog|licen'
if(Test-Path -LiteralPath $q -EA SilentlyContinue){ $leaf=[IO.Path]::GetFileNameWithoutExtension($q); $cands+=Cand $q 'exe' $q 'path' $leaf 100 }
elseif($q -match '^[a-z][a-z0-9+.\-]+:'){
  # appid из URI — чтобы «steam://rungameid/<id>», пришедший ГОТОВОЙ строкой от модели, сверялся так же,
  # как найденный резолвером по имени (именно этот путь и рапортовал успех на любой мусор).
  $aid=$null; if($q -match '^steam://(?:rungameid|launch|run)/(\d+)'){ $aid=$Matches[1] }
  $cands+=Cand $q 'uri' $q 'uri' '' 100 $aid
}
else {
  $appPathBases='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths'
  foreach($base in $appPathBases){
    $exact=Join-Path $base ($q+'.exe')
    if(Test-Path $exact){ $p=(Get-ItemProperty $exact).'(default)'; if($p){ $p=$p.Trim('"'); $cands+=Cand $p 'exe' ([IO.Path]::GetFileName($p)) 'AppPaths' ([IO.Path]::GetFileNameWithoutExtension($p)) 100 } }
  }
  $libs=@(SteamLibs)
  if($libs.Count -gt 0){
    $seen=@{}
    foreach($l in $libs){
      $sa=Join-Path $l 'steamapps'; if(-not(Test-Path $sa)){continue}
      foreach($acf in Get-ChildItem $sa -Filter 'appmanifest_*.acf' -EA SilentlyContinue){
        $t=Get-Content $acf.FullName -Raw; $id=$null;$nm=$null
        if($t -match '"appid"\s+"(\d+)"'){$id=$Matches[1]}
        if($t -match '"name"\s+"(.+?)"'){$nm=$Matches[1]}
        if(-not($id -and $nm)){continue}; if($seen.ContainsKey($id)){continue}; $seen[$id]=$true
        if($nm -match $junk){continue}
        $gn=Norm $nm; $dist=Lev $qn $gn
        if($gn.Contains($qn) -or $qn.Contains($gn)){ $dist=0 }
        if($dist -le 2){ $cands+=Cand ("steam://rungameid/$id") 'uri' $nm "Steam(d=$dist)" '' (86-$dist*8) $id }
      }
    }
  }
  # Каталоги меню Пуск. JARVIS_START_MENU_DIRS (через ';') подменяет их — так гард «не запускать
  # деинсталлятор» проверяется НАСТОЯЩИМ прогоном на временных ярлыках, а не грепом по исходнику.
  $menus=if($env:JARVIS_START_MENU_DIRS){ $env:JARVIS_START_MENU_DIRS -split ';' } else { "$env:ProgramData\Microsoft\Windows\Start Menu\Programs","$env:AppData\Microsoft\Windows\Start Menu\Programs" }
  $wsh=New-Object -ComObject WScript.Shell
  foreach($lnk in (Get-ChildItem $menus -Recurse -Filter '*.lnk' -EA SilentlyContinue)){
    $bn=Norm $lnk.BaseName; if(-not $bn){continue}
    # Дистанция: точное совпадение и ПРЕФИКС — идеальный матч; произвольное вхождение больше НЕ
    # обнуляет расстояние (иначе «деинсталлировать telegram» и «telegram web» равны «telegram»).
    $d=Lev $qn $bn
    if($bn -eq $qn){ $d=0 } elseif($bn.StartsWith($qn) -or $qn.StartsWith($bn)){ $d=1 }
    # Служебный ярлык (удалить/справка/сайт) — не приложение: сильный штраф, но не запрет.
    $penalty=0; if($bn -match $junkName){ $penalty=45 }
    if($d -le 2){
      $tp=$wsh.CreateShortcut($lnk.FullName).TargetPath
      if($tp -and (Test-Path $tp)){
        $tn=[IO.Path]::GetFileNameWithoutExtension($tp).ToLower()
        # Рубеж 1: деинсталлятор в цели — кандидат не рассматривается ВООБЩЕ.
        if($tn -notmatch $badTarget){
          $cands+=Cand $tp 'exe' $lnk.BaseName "StartMenu(d=$d)" ([IO.Path]::GetFileNameWithoutExtension($tp)) (90-$d*10-$penalty)
        }
      }
    }
  }
  $w=(Get-Command -Name $q -CommandType Application -EA SilentlyContinue | Select-Object -First 1).Source
  if($w){ $cands+=Cand $w 'exe' ([IO.Path]::GetFileName($w)) 'PATH' ([IO.Path]::GetFileNameWithoutExtension($w)) 95 }
}
if($cands.Count -eq 0){ Write-Output ('RESOLVE:FAIL reason=not-found q='+$q); exit 1 }
$best=($cands | Sort-Object -Property @{Expression='score';Descending=$true},@{Expression={$_.target.Length};Descending=$false})[0]
# Рубеж 3 (защита в глубину): что бы ни выбрал скоринг из ЛЮБОГО источника — деинсталлятор по
# просьбе «открой приложение» не запускается. Честный отказ лучше удалённой программы.
if($best.kind -eq 'exe' -and ([IO.Path]::GetFileNameWithoutExtension($best.target).ToLower() -match $badTarget)){
  Write-Output ('RESOLVE:FAIL reason=uninstaller-blocked q='+$q+' target='+$best.target); exit 1
}
function SayOk($b,$verified){ Write-Output ("LAUNCH:OK target={0} | kind={1} | display={2} | source={3} | verified={4}" -f $b.target,$b.kind,$b.display,$b.source,$verified) }
if($env:JARVIS_DRYRUN -eq '1'){
  # hints в dry-run — чтобы вывод пути «манифест -> installdir -> exe» проверялся тестом БЕЗ запуска игры.
  $dh=@(SteamGameHints $best.appid) -join ','
  Write-Output ("RESOLVE:OK target={0} | kind={1} | display={2} | source={3} | appid={4} | hints={5}" -f $best.target,$best.kind,$best.display,$best.source,$best.appid,$dh); exit 0
}
$waitMs=[int]($env:JARVIS_WAIT_MS); if($waitMs -le 0){ $waitMs=1500 }
# Ожидание игры: Steam ещё поднимает бутстрап -> процесс/RunningAppID появляются НЕ мгновенно. Потолок
# ограничен сверху hard-таймаутом лаунчера (25с в TS) и серверным окном app.launch (30с).
$steamWaitMs=[int]($env:JARVIS_STEAM_WAIT_MS); if($steamWaitMs -le 0){ $steamWaitMs=12000 }
try {
  if($best.kind -eq 'exe'){
    $p=Start-Process -FilePath $best.target -PassThru
    if(-not $p){ Write-Output 'LAUNCH:FAIL reason=no-process'; exit 1 }
    Start-Sleep -Milliseconds $waitMs
    if(Get-Process -Id $p.Id -EA SilentlyContinue){ Write-Output ("LAUNCH:OK target={0} | kind=exe | pid={1} | display={2} | source={3} | verified=process" -f $best.target,$p.Id,$best.display,$best.source) }
    else {
      # Процесс вышел. Для СТАБ-ЛОНЧЕРОВ (UWP/Store-приложения: Калькулятор/calc, Камера, Фото и т.п.)
      # exe МГНОВЕННО отдаёт управление реальному приложению и выходит с кодом 0 — это УСПЕШНЫЙ хэндофф,
      # а не провал (баг ложного негатива: приложение открылось, а Джарвис рапортовал «не вышло»).
      # Ненулевой/нечитаемый код выхода → реальный провал запуска (честно).
      $ec=$null; try{ $ec=$p.ExitCode }catch{}
      # Стаб-лончер отдал управление реальному приложению: хэндофф состоялся, но САМ запуск приложения
      # мы не наблюдали — честно помечаем handoff, а не выдаём за подтверждённый процесс.
      if($ec -eq 0){ Write-Output ("LAUNCH:OK target={0} | kind=exe | pid={1} | display={2} | source={3} | verified=handoff" -f $best.target,$p.Id,$best.display,$best.source) }
      else { Write-Output ("LAUNCH:FAIL reason=process-exited-immediately exit={0}" -f $ec) }
    }
  } else {
    $hints=@(); if($best.hint){ $hints+=$best.hint }
    $hints+=@(SteamGameHints $best.appid)
    $hints=@($hints | Where-Object { $_ } | Select-Object -Unique)
    $before=CountProcs $hints
    $runningNow=(SteamRunningAppId)
    # Игра уже идёт — второй rungameid ничего не «запустит», и ждать появления процесса бессмысленно.
    # 🔴 КРОСС-ПРОВЕРКА (адверс-ревью 2026-09-01): RunningAppID — ЗНАЧЕНИЕ В РЕЕСТРЕ; оно переживает
    # падение игры и самого Steam. Если exe игры известны (hints), а НИ ОДНОГО её процесса нет —
    # значение протухло, и «уже запущено» было бы ложным успехом по ОДНОМУ непроверенному признаку
    # (процессы посчитаны строкой выше и раньше просто выбрасывались). Сверять нечем только когда
    # hints пусты — тогда appid остаётся единственным признаком, как и был.
    $stale=($best.appid -and $runningNow -eq $best.appid -and $hints.Count -gt 0 -and $before -eq 0)
    $already=($best.appid -and $runningNow -eq $best.appid -and -not $stale)
    if($env:JARVIS_LAUNCH_NO_EXEC -ne '1'){ Start-Process -FilePath $best.target }
    if($best.appid){
      if($already){ SayOk $best 'appid-already'; exit 0 }
      $deadline=(Get-Date).AddMilliseconds([Math]::Max($waitMs,$steamWaitMs))
      do {
        Start-Sleep -Milliseconds 400
        # При протухшем значении appid-признак бесполезен: он УЖЕ равен целевому и сработал бы
        # мгновенно тем же обманом. Ждём реальный процесс игры.
        if(-not $stale -and (SteamRunningAppId) -eq $best.appid){ SayOk $best 'appid'; exit 0 }
        if((CountProcs $hints) -gt $before){ SayOk $best 'process'; exit 0 }
      } while((Get-Date) -lt $deadline)
      # 🔴 Ровно тот случай, где раньше врали «Готово»: обработчик URI принял команду, а игра не пошла
      # (нет такого appid / не установлена / Steam показал ошибку). Человеческий текст — в TS (маркер ASCII).
      # Протухший appid — ОТДЕЛЬНАЯ причина: там RunningAppID как раз совпадает, и общий текст «ни appid,
      # ни процесс не подтвердили» был бы неправдой.
      if($stale){ Write-Output ('LAUNCH:FAIL reason=steam-appid-stale appid='+$best.appid); exit 1 }
      Write-Output ('LAUNCH:FAIL reason=steam-not-confirmed appid='+$best.appid)
      exit 1
    }
    # Прочие URI (ms-settings:, https:, tg:) сверять нечем: обработчик схемы не отчитывается.
    if($hints.Count -eq 0){ SayOk $best 'handoff'; exit 0 }
    $deadline=(Get-Date).AddMilliseconds([Math]::Max($waitMs,8000))
    do { Start-Sleep -Milliseconds 400; if((CountProcs $hints) -gt $before){ SayOk $best 'process'; exit 0 } } while((Get-Date) -lt $deadline)
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
        log.info(
          `launch "${query}" → [${kv.source}] ${kv.display} (${kv.kind}:${kv.target})` +
            (kv.verified ? ` подтверждение: ${kv.verified}` : ""),
        );
        resolve({
          resolved: kv.target ?? query,
          kind: kv.kind ?? "",
          display: kv.display ?? query,
          source: kv.source ?? "",
          pid: kv.pid ? Number.parseInt(kv.pid, 10) : undefined,
          verified: kv.verified || undefined,
          appid: kv.appid || undefined,
          hints: kv.hints || undefined,
        });
        return;
      }
      const failLine = lines.find((l) => /:FAIL\b/.test(l)) ?? "";
      const reason = failLine.match(/reason=([\s\S]+)$/)?.[1]?.trim() ?? "не удалось запустить";
      const code = /not-found/.test(failLine) ? "not_found" : "launch_failed";
      log.warn(`launch "${query}" провал: ${reason}`);
      // Провал сверки Steam-игры объясняем по-человечески: раньше на этом месте было ложное «Готово»,
      // и модель обязана понимать, что делать дальше (сверить окном), а не перезапускать вслепую.
      const hint = /steam-not-confirmed/.test(reason)
        ? ": Steam принял команду, но ни процесс игры, ни RunningAppID запуск не подтвердили " +
          "(нет такого appid / игра не установлена / ещё грузится). Сверь окном (window_list/wait_for), вслепую не перезапускай"
        : /steam-appid-stale/.test(reason)
          ? ": Steam помечает игру как идущую (RunningAppID), но НИ ОДНОГО её процесса нет — значение " +
            "могло остаться от прошлого сеанса. Запуск подтвердить не могу. Сверь окном (window_list/wait_for)"
          : `: ${reason}`;
      reject(new LaunchError(`не удалось запустить «${query}»${hint}`, code));
    });
  });
}
