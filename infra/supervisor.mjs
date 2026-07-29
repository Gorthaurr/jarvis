#!/usr/bin/env node
/**
 * Супервизор Джарвис-сервера (аудит 2026-07-28, P0 «не живёт сам» + «умер ночью — никто не узнал»;
 * захарден адверс-ревью того же дня: single-instance-лок, возврат в watch-only, честный Telegram-алерт,
 * spawn-error-хендлеры, закрытие fd, env-цепочка как у сервера).
 *
 * Раньше мозг поднимался руками (`npx tsx src/index.ts`) и после падения/перезагрузки лежал молча —
 * живой факт аудита: сервер пролежал 3 дня без единого сигнала. Супервизор:
 *   • спавнит сервер и РЕСТАРТУЕТ его с бэкоффом 1с→60с (сброс бэкоффа после аптайма ≥60с);
 *   • ПЕРЕД каждым (ре)стартом пробует /healthz: сервер уже жив (ручной dev-запуск) → режим
 *     НАБЛЮДАТЕЛЯ, второй процесс не плодим (EADDRINUSE-грабля) — и так же ВОЗВРАЩАЕТСЯ в
 *     наблюдение, если ручной сервер вернулся (ревью [16]: не воюем с dev-рестартом владельца);
 *   • watchdog: N провалов /healthz подряд → перезапуск своего ребёнка + АЛЕРТ; чужой зависший
 *     процесс на порту убить не можем — честный алерт «порт занят, разберитесь» (ревью [9]);
 *   • алерты владельцу: Telegram-бот (env JARVIS_ALERT_TG_TOKEN/JARVIS_ALERT_TG_CHAT; НЕ-2xx → фолбэк,
 *     ревью [8]) → msg.exe → всегда infra/supervisor.log; троттл 15 мин/тип;
 *   • single-instance: PID-лок infra/supervisor.lock — вторая копия выходит сразу (ревью [18]).
 *
 * Запуск: `node infra/supervisor.mjs` из корня jarvis/ (автозапуск — infra/register-autostart.ps1).
 * Стоп: Ctrl+C / SIGTERM — гасит дерево ребёнка (taskkill /T /F на Windows).
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// (mkdirSync/appendFileSync — ещё и для durable-инцидентов голосового доклада, см. recordIncident)
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_CWD = join(ROOT, "apps", "server");
const LOG_FILE = join(ROOT, "infra", "supervisor.log");
const LOCK_FILE = join(ROOT, "infra", "supervisor.lock");

// ── env: process.env + минимальный парс .env ПО ТОЙ ЖЕ цепочке, что сервер (ревью [28]:
// расхождение источников PORT = вечный kill/restart здорового сервера): JARVIS_ENV_PATH → jarvis/.env.
const dotenv = {};
const envFile = process.env.JARVIS_ENV_PATH?.trim() || join(ROOT, ".env");
try {
  for (const line of readFileSync(envFile, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) dotenv[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
} catch {
  /* .env нет — работаем на дефолтах */
}
const env = (k, d) => process.env[k] ?? dotenv[k] ?? d;

const PORT = Number.parseInt(env("PORT", "8787"), 10) || 8787;
// Каталог данных сервера (та же цепочка, что paths.ts): JARVIS_DATA_DIR → apps/server/data.
const DATA_DIR = (env("JARVIS_DATA_DIR", "") || "").trim() || join(SERVER_CWD, "data");
const INCIDENTS_FILE = join(DATA_DIR, "incidents.jsonl");
const HEALTH_URL = `http://127.0.0.1:${PORT}/healthz`;
const HEALTH_EVERY_MS = Math.max(10_000, Number.parseInt(env("JARVIS_SUP_HEALTH_MS", "60000"), 10) || 60_000);
const HEALTH_FAILS_TO_RESTART = 3; // ~3 мин молчания → рестарт
const ALERT_THROTTLE_MS = 15 * 60_000; // не чаще раза в 15 мин на тип

function log(msg, meta) {
  const line = `${new Date().toISOString()} ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`;
  console.log(line);
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    /* fail-safe */
  }
}

// ── single-instance-лок (ревью [18]: две копии супервизора = два спавнера сервера) ──────────
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** Живой ли ИМЕННО супервизор с таким PID (контрольное ревью: ОС переиспользует PID — «жив» без
 *  сверки командной строки мог принадлежать чужому процессу, и супервизор МОЛЧА не стартовал). */
function supervisorAlive(pid) {
  if (!processAlive(pid)) return false;
  if (process.platform !== "win32") return true; // на *nix ограничиваемся сигналом 0
  try {
    const out = execFileSync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/format:list"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    return /supervisor\.mjs/i.test(out);
  } catch (e) {
    // Не смогли проверить (нет wmic/таймаут) — консервативно «занято», но ГРОМКО: под Task Scheduler
    // stdout никуда не идёт, и молчаливый неподъём выглядел бы как «Джарвис просто не запустился».
    log(`не удалось сверить командную строку PID ${pid} (${String(e?.message ?? e)}) — считаю лок занятым`);
    return true;
  }
}
try {
  const prev = Number.parseInt(readFileSync(LOCK_FILE, "utf8"), 10);
  if (Number.isFinite(prev) && prev !== process.pid && supervisorAlive(prev)) {
    // Финальное ревью: пишем в ФАЙЛ лога, а не только в stdout — под автозапуском консоли нет,
    // и «почему супервизор не поднялся» иначе не восстановить.
    log(`супервизор уже запущен (PID ${prev}) — вторая копия выходит`);
    process.exit(0);
  }
  if (Number.isFinite(prev) && prev !== process.pid) {
    // Стейл-лок (процесс умер / PID переиспользован чужим) — перезаписываем и ГОВОРИМ об этом,
    // иначе «молчаливый отказ старта» выглядел бы как «Джарвис не поднялся без причины».
    log(`стейл-лок от PID ${prev} — перезаписываю (супервизор с таким PID не найден)`);
  }
} catch {
  /* лока нет — норм */
}
try {
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  writeFileSync(LOCK_FILE, String(process.pid), "utf8");
} catch {
  /* не критично: без лока работаем, но честно логируем */
  log("не удалось записать supervisor.lock — защита от второй копии не активна");
}

// ── алерты (Telegram-бот → Windows msg.exe → лог всегда) ────────────────────────────────────
const lastAlertAt = new Map();
/** Спавн вспомогательной команды с проглатыванием ошибок (ревью [11]/[26]: ENOENT без хендлера валил процесс). */
function spawnQuiet(cmd, args) {
  try {
    const p = spawn(cmd, args, { stdio: "ignore" });
    p.on("error", () => {
      /* нет бинаря/прав — best-effort канал, не критично */
    });
    p.unref();
  } catch {
    /* синхронный провал спавна — тоже не критично */
  }
}
/**
 * Записать инцидент для ГОЛОСОВОГО доклада Джарвиса (главный канал — ничего настраивать не надо).
 * Сервер при подключении владельца прочитает `data/incidents.jsonl` и скажет вслух, что падал.
 */
function recordIncident(kind, text) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(INCIDENTS_FILE, `${JSON.stringify({ ts: new Date().toISOString(), kind, text })}\n`, "utf8");
  } catch (e) {
    log("не удалось записать инцидент для голосового доклада", { error: String(e?.message ?? e) });
  }
}

/**
 * Нативное Windows-уведомление (toast) БЕЗ установки чего-либо: WinRT-шаблон через PowerShell.
 * Работает из коробки; если API недоступен (не Win10+/политика) — молча ничего, есть другие каналы.
 */
function toastWindows(text) {
  if (process.platform !== "win32") return;
  const safe = String(text).replace(/[^\p{L}\p{N} .,:!?—()\-/]/gu, " ").slice(0, 180); // без кавычек/XML-мета
  const ps = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null",
    "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$n=$t.GetElementsByTagName('text')",
    "$n.Item(0).AppendChild($t.CreateTextNode('Джарвис')) > $null",
    `$n.Item(1).AppendChild($t.CreateTextNode('${safe}')) > $null`,
    "$app='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))",
  ].join("; ");
  spawnQuiet("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps]);
}

/**
 * Канал алертов ПО УМОЛЧАНИЮ — без токенов и регистрации чего-либо:
 *   1) durable-инцидент → Джарвис САМ доложит голосом при подключении владельца (главный канал);
 *   2) нативный Windows-toast (видно сразу, если владелец за ПК);
 *   3) msg.exe (Windows Pro) — запасной попап;
 *   4) infra/supervisor.log — всегда.
 * Telegram-бот остаётся ЧИСТО ОПЦИОНАЛЬНЫМ (env заданы → шлём и туда, для «узнать вне дома»).
 */
async function alert(kind, text) {
  log(`ALERT[${kind}] ${text}`);
  // Инцидент пишем ДО троттла (ревью [6]): троттл существует, чтобы не спамить ПОПАПАМИ, а durable-факт
  // сбоя терять нельзя — иначе событие, попавшее в 15-минутное окно, не доложится НИГДЕ (в exit-ветке
  // оно к тому времени уже подавлено флагом unreportedCrash).
  recordIncident(kind, text); // → голосовой доклад Джарвиса (работает всегда, ничего не настраивать)
  const prev = lastAlertAt.get(kind) ?? 0;
  if (Date.now() - prev < ALERT_THROTTLE_MS) return; // троттл — не спамим ПОПАПАМИ
  lastAlertAt.set(kind, Date.now());
  toastWindows(text);
  if (process.platform === "win32") {
    // msg.exe: системное сообщение текущему пользователю (Windows Pro). Best-effort.
    spawnQuiet("msg", [process.env.USERNAME ?? "*", `Джарвис: ${text}`]);
  }
  const tgToken = env("JARVIS_ALERT_TG_TOKEN", "");
  const tgChat = env("JARVIS_ALERT_TG_CHAT", "");
  if (!tgToken || !tgChat) return; // не настроен — и не надо, каналы выше уже отработали
  try {
    const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tgChat, text: `🤖 Джарвис: ${text}` }),
    });
    if (!r.ok) log("алерт в Telegram отвергнут API (локальные каналы уже сработали)", { status: r.status });
  } catch (e) {
    log("алерт в Telegram не ушёл (локальные каналы уже сработали)", { error: String(e?.message ?? e) });
  }
}

async function healthOk() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(HEALTH_URL, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

// ── жизненный цикл ребёнка ──────────────────────────────────────────────────────────────────
let child = null;
let stopping = false;
let backoffMs = 1000;
let startedAt = 0;
let restartsWindow = []; // таймстемпы рестартов для детекта crash-loop
let watchOnly = false; // сервер запущен кем-то другим (ручной dev-запуск) — не плодим второй
let starting = false; // in-flight латч: startServer асинхронен (await healthOk) — см. ниже
let downSince = 0; // когда сервер перестал работать (для честного «лежал N минут»)
let downMeta = null; // подробности последнего падения (код/сигнал/аптайм) — в текст инцидента
let unreportedCrash = false; // инцидент об этом падении уже записан (анти-дубль, ревью [4])

async function startServer() {
  // Контрольное ревью: гард `child` проверялся ДО `await healthOk()` — за это окно второй вызов
  // (watchdog-тик + backoff-таймер) проходил гард и спавнил ВТОРОГО ребёнка, затирая ссылку на
  // первого (нетрекаемый сирота на занятом порту). Латч ставится СИНХРОННО, снимается в finally.
  if (stopping || child || starting) return;
  starting = true;
  try {
    await startServerInner();
  } finally {
    starting = false;
  }
}

async function startServerInner() {
  // Ревью [16]/[23]: ПЕРЕД каждым (ре)стартом — проба. Ручной сервер уже жив (вернулся dev-рестарт
  // владельца / наш ребёнок умер от EADDRINUSE рядом с живым чужим) → возвращаемся в наблюдение.
  if (await healthOk()) {
    if (!watchOnly) log("сервер уже отвечает (ручной запуск?) — возвращаюсь в режим наблюдателя");
    watchOnly = true;
    // Контрольное ревью: сервис ВОССТАНОВЛЕН (кем-то другим) — закрываем учёт простоя ЗДЕСЬ, иначе
    // downSince жил бы весь период наблюдения и позже дал бы ложное «я был недоступен 12 часов»
    // (а залипший unreportedCrash, наоборот, подавил бы первый настоящий доклад после takeover).
    if (downSince > 0) {
      const downMs = Date.now() - downSince;
      const minDownMs = Number.parseInt(env("JARVIS_INCIDENT_MIN_DOWN_MS", "60000"), 10) || 60_000;
      if (downMs >= minDownMs && !unreportedCrash) {
        recordIncident("downtime", `я был недоступен около ${Math.max(1, Math.round(downMs / 60_000))} мин и снова на связи`);
      }
      downSince = 0;
      downMeta = null;
      unreportedCrash = false;
    }
    return;
  }
  watchOnly = false;
  // Конвенция HOW_IT_WORKS: stdout/stderr сервера → server.out.log / server.err.log (append).
  let out = "ignore";
  let err = "ignore";
  let outFd = null;
  let errFd = null;
  try {
    outFd = openSync(join(SERVER_CWD, "server.out.log"), "a");
    errFd = openSync(join(SERVER_CWD, "server.err.log"), "a");
    out = outFd;
    err = errFd;
  } catch {
    /* не критично */
  }
  // Локальный tsx из workspace (pnpm кладёт .bin в корень репо); фолбэк — npx.
  const tsxCmd = ["node_modules/.bin/tsx.cmd", "node_modules/.bin/tsx"]
    .map((p) => join(ROOT, p))
    .find((p) => existsSync(p));
  const cmd = tsxCmd ?? "npx";
  const args = tsxCmd ? ["src/index.ts"] : ["tsx", "src/index.ts"];
  try {
    child = spawn(cmd, args, { cwd: SERVER_CWD, stdio: ["ignore", out, err], shell: !tsxCmd || cmd.endsWith(".cmd") });
  } catch (e) {
    child = null;
    log("спавн сервера упал синхронно — повтор по бэкоффу", { error: String(e?.message ?? e) });
    scheduleRestart();
    return;
  } finally {
    // Ревью [12]/[27]: spawn КОПИРУЕТ fd в ребёнка — родительские дескрипторы закрываем сразу,
    // иначе каждый рестарт течёт двумя fd (в crash-loop канал логов молча умирал бы).
    if (outFd !== null) try { closeSync(outFd); } catch { /* уже закрыт */ }
    if (errFd !== null) try { closeSync(errFd); } catch { /* уже закрыт */ }
  }
  startedAt = Date.now();
  log("сервер запущен", { pid: child.pid, cmd: tsxCmd ?? "npx tsx" });
  // Сервер снова на ногах: если простой был ЗАМЕТНЫМ (владелец в это время реально остался без
  // Джарвиса) — durable-инцидент для голосового доклада. Короткий рестарт (в т.ч. ручной деплой
  // владельца) НЕ докладываем: врать «я падал» про его же действие нельзя (ревью [3][8]).
  if (downSince > 0) {
    const downMs = Date.now() - downSince;
    const minDownMs = Number.parseInt(env("JARVIS_INCIDENT_MIN_DOWN_MS", "60000"), 10) || 60_000;
    if (downMs >= minDownMs && !unreportedCrash) {
      const mins = Math.max(1, Math.round(downMs / 60_000));
      recordIncident("downtime", `я был недоступен около ${mins} мин и восстановился сам (код ${downMeta?.code ?? "?"})`);
    }
    downSince = 0;
    downMeta = null;
    unreportedCrash = false;
  }
  child.on("error", (e) => {
    // Ревью [26]: асинхронный провал спавна (ENOENT npx) без хендлера валил САМ супервизор.
    log("спавн сервера упал асинхронно — повтор по бэкоффу", { error: String(e?.message ?? e) });
    child = null;
    scheduleRestart();
  });
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    const uptimeSec = Math.round((Date.now() - startedAt) / 1000);
    if (uptimeSec >= 60) backoffMs = 1000; // долго жил → сброс бэкоффа
    restartsWindow = [...restartsWindow.filter((t) => Date.now() - t < 10 * 60_000), Date.now()];
    log("сервер упал — рестарт по бэкоффу", { code, signal, uptimeSec, backoffMs, restartsIn10m: restartsWindow.length });
    // ЧТО ИМЕННО докладывать голосом (адверс-ревью [3][8]): НЕ каждый exit. Владелец штатно
    // перезапускает сервер вручную (документированный dev-цикл: убить процесс на 8787 → поднять) и
    // Windows гасит процессы при выключении — писать это как «я падал» = ЛОЖНЫЙ доклад о состоянии
    // (нарушение закона честности) и обесценивание канала. Инцидент фиксируем, только если сбой
    // РЕАЛЬНО задел владельца или выглядит аварийно:
    //   • аптайм < 60с — сервер не смог удержаться (падает на старте);
    //   • иначе — решает ДЛИТЕЛЬНОСТЬ ПРОСТОЯ: её знает следующий успешный старт (см. downSince).
    downSince = Date.now();
    downMeta = { code, signal, uptimeSec };
    // Короткоживущий exit — ЧАЩЕ ВСЕГО не падение, а проигрыш гонки за порт ручному запуску владельца
    // (документированный dev-цикл). Поэтому перед записью «упал» СПРАШИВАЕМ порт: если healthz отвечает,
    // значит Джарвис жив (там чужой/ручной процесс) — владельцу докладывать НЕЧЕГО (ревью [3][5]).
    // unreportedCrash-гард — против дубля с alert-веткой watchdog (ревью [8]).
    if (uptimeSec < 60 && !unreportedCrash) {
      const uptimeAtExit = uptimeSec;
      const episode = downSince; // СНИМОК эпизода: к нему относится результат пробы
      void (async () => {
        await new Promise((r) => setTimeout(r, 1500)); // дать сопернику добиндить порт
        if (stopping || (await healthOk())) {
          log("короткий exit рядом с живым сервером — это не падение, инцидент не пишу", { uptimeSec: uptimeAtExit });
          return;
        }
        if (downSince === episode && unreportedCrash) return; // этот эпизод уже записан кем-то
        recordIncident("crash", `сервер упал через ${uptimeAtExit}с после старта и был перезапущен автоматически`);
        // Флаг анти-дубля ставим ТОЛЬКО если эпизод ЕЩЁ ТОТ ЖЕ (контрольное ревью, гонка с бэкоффом:
        // рестарт мог сработать раньше пробы — 1с бэкоффа против 1.5с паузы — и уже закрыть эпизод;
        // взведённый «задним числом» флаг тогда глушил бы доклад о СЛЕДУЮЩЕМ, ни в чём не повинном падении).
        if (downSince === episode) unreportedCrash = true;
      })();
    }
    if (restartsWindow.length >= 5) {
      // Ревью [9]: если при этом healthz ЖИВ — рядом чужой сервер, наш ребёнок бьётся об занятый порт;
      // startServer сам вернёт нас в watch-only. Если порт занят ЗАВИСШИМ чужим процессом (healthz
      // мёртв) — убить его мы не вправе, честно зовём владельца.
      void alert(
        "crash-loop",
        `сервер падает подряд (${restartsWindow.length} рестартов за 10 мин, код ${code}). ` +
          `Если порт ${PORT} занят зависшим процессом — завершите его вручную. Детали: apps/server/server.err.log`,
      );
    }
    scheduleRestart();
  });
}

function scheduleRestart() {
  if (stopping) return;
  setTimeout(() => void startServer(), backoffMs);
  backoffMs = Math.min(backoffMs * 2, 60_000);
}

function killChildTree() {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") spawnQuiet("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    else child.kill("SIGTERM");
  } catch {
    /* уже мёртв */
  }
}

// ── watchdog ────────────────────────────────────────────────────────────────────────────────
let healthFails = 0;
async function watchdogTick() {
  const ok = await healthOk();
  if (ok) {
    if (healthFails > 0) log("healthz снова отвечает", { былоПровалов: healthFails });
    healthFails = 0;
    return;
  }
  healthFails += 1;
  log("healthz не отвечает", { подряд: healthFails, url: HEALTH_URL, watchOnly });
  if (healthFails < HEALTH_FAILS_TO_RESTART) return;
  healthFails = 0;
  if (watchOnly) {
    // Внешний (ручной) сервер умер → пробуем подхватить. startServer сам перепроверит healthz
    // (медленный-но-живой не трогаем) и вернёт watch-only, если тот очнулся.
    void alert("takeover", "ручной сервер перестал отвечать — супервизор пробует поднять свой процесс");
    void startServer();
    return;
  }
  if (child) {
    void alert("health", `сервер жив как процесс, но не отвечал ${HEALTH_FAILS_TO_RESTART} проверки подряд — перезапускаю`);
    // Анти-дубль (ревью [4]): alert уже записал инцидент об ЭТОМ событии — последующий exit нашего
    // же kill не должен добавить второй, иначе доклад завышал бы число сбоев вдвое.
    unreportedCrash = true;
    killChildTree(); // exit-хендлер сам перезапустит по бэкоффу
  } else {
    // Ребёнка нет (между рестартами/бэкофф) — форсим попытку старта.
    void startServer();
  }
}

// ── main ────────────────────────────────────────────────────────────────────────────────────
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
function shutdown() {
  stopping = true;
  log("супервизор останавливается — гашу сервер");
  killChildTree();
  try {
    rmSync(LOCK_FILE, { force: true });
  } catch {
    /* не критично */
  }
  setTimeout(() => process.exit(0), 1500);
}

await startServer(); // сам решит: спавнить или наблюдать за уже живым
setInterval(() => void watchdogTick(), HEALTH_EVERY_MS);
log("супервизор запущен", { port: PORT, healthEveryMs: HEALTH_EVERY_MS, watchOnly, envFile });
