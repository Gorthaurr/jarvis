/**
 * Хранитель клиента (2026-09-24, корень «Джарвис вообще не работает»).
 *
 * Супервизор держал только СЕРВЕР. Electron-клиент (уши, рот, руки) после перезагрузки не запускался вовсе,
 * а после краша лежал молча: серверные логи 18–24.09 — сплошное «напоминание сработало, но нет активной
 * сессии». Хранитель:
 *   • запускает клиент вместе с супервизором (а супервизор — задача Windows при входе);
 *   • перезапускает его после ПАДЕНИЯ (ненулевой код выхода) с бэкоффом 3 с → 2 мин;
 *   • НЕ перезапускает после штатного выхода (код 0: «Выйти» из трея, выключение Windows) — владелец сам
 *     закрыл Джарвиса, воевать с ним нельзя; следующий вход в Windows поднимет клиент снова;
 *   • НЕ плодит второй экземпляр: клиент уже запущен руками (любой electron.exe из node_modules проекта) →
 *     наблюдение; тот исчез → поднимаем свой (это и есть «живёт сам»), КРОМЕ случая, когда владелец нажал
 *     «Выйти» — клиент пишет маркер %APPDATA%/@jarvis/client/owner-quit.json (main/owner-quit.ts);
 *   • серия падений → честный алерт (тот же канал, что у сервера: голосовой доклад + toast).
 * Выключатель: JARVIS_SUP_CLIENT=0.
 */
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const BACKOFF_MIN_MS = 3_000;
const BACKOFF_MAX_MS = 120_000;
const WATCH_POLL_MS = 30_000;
const STABLE_UPTIME_MS = 60_000;

/** Разбор `wmic ... /format:csv`: пути exe живых процессов electron.exe. Экспорт для теста. */
export function parseElectronPaths(csv) {
  const out = [];
  for (const line of String(csv).split(/\r?\n/)) {
    const cells = line.split(",");
    if (cells.length < 3 || /^Node$/i.test(cells[0])) continue;
    const path = cells.slice(1, -1).join(",").trim();
    const pid = Number.parseInt(cells[cells.length - 1], 10);
    if (path && Number.isFinite(pid)) out.push({ path, pid });
  }
  return out;
}

/** Решение по выходу клиента (чистое): перезапускать ли. Экспорт для теста. */
export function exitDecision({ code, signal, uptimeMs, otherAlive, ownerQuitMarked }) {
  if (ownerQuitMarked) return "owner-quit"; // «Выйти» из трея — воля владельца, не падение
  if (otherAlive) return "watch"; // проиграли single-instance лок ручному экземпляру
  if (code === 0 && !signal) return uptimeMs < 5_000 ? "watch" : "owner-quit";
  return "restart";
}

export function startClientKeeper({ root, env, log, alert }) {
  const noop = { stop() {} };
  if (process.platform !== "win32") return noop;
  if (env("JARVIS_SUP_CLIENT", "1") === "0") {
    log("хранитель клиента выключен (JARVIS_SUP_CLIENT=0)");
    return noop;
  }
  const clientDir = join(root, "apps", "client");
  let electronExe;
  try {
    electronExe = createRequire(join(clientDir, "package.json"))("electron");
  } catch (e) {
    log("хранитель клиента: electron не найден в apps/client — клиент не поднимаю", { error: String(e?.message ?? e) });
    return noop;
  }
  if (!existsSync(join(clientDir, "dist", "main", "index.cjs"))) {
    void alert("client-missing", "клиент не собран (apps/client/dist) — выполните `node apps/client/scripts/build.mjs`");
    return noop;
  }

  const ownerQuitFile = join(process.env.APPDATA ?? "", "@jarvis", "client", "owner-quit.json");
  /** Маркер «Выйти» новее момента since — владелец закрыл клиент сам. */
  const ownerQuitSince = (since) => {
    try {
      return statSync(ownerQuitFile).mtimeMs >= since;
    } catch {
      return false;
    }
  };
  let watchingSince = 0;
  let child = null;
  let startedAt = 0;
  let backoffMs = BACKOFF_MIN_MS;
  let stopping = false;
  let ownerQuit = false;
  let timer = null;
  let crashes = [];

  const otherClients = () => {
    try {
      // Только ГЛАВНЫЕ процессы: у дочерних Chromium (GPU/renderer/utility) в командной строке есть --type=, и они
      // ещё живут мгновение после смерти главного — без фильтра хранитель принимал их за «другой экземпляр».
      const where = "name='electron.exe' and not CommandLine like '%--type=%'";
      const csv = execFileSync("wmic", ["process", "where", where, "get", "ExecutablePath,ProcessId", "/format:csv"], {
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true,
      });
      const mine = electronExe.toLowerCase();
      return parseElectronPaths(csv).filter((p) => p.path.toLowerCase() === mine && p.pid !== child?.pid);
    } catch {
      return []; // не смогли проверить — считаем, что чужих нет (худший случай: второй экземпляр сам выйдет по локу)
    }
  };

  const schedule = (ms, why) => {
    if (stopping) return;
    clearTimeout(timer);
    timer = setTimeout(() => void tick(why), ms);
  };

  const spawnClient = () => {
    // stdout/stderr клиента → apps/client/client.{out,err}.log (append, как у сервера): фатальные сообщения Chromium
    // («GPU process isn't usable. Goodbye») пишутся ТОЛЬКО в stderr — без файла краш клиента был бы немым.
    let outFd = null;
    let errFd = null;
    try {
      outFd = openSync(join(clientDir, "client.out.log"), "a");
      errFd = openSync(join(clientDir, "client.err.log"), "a");
    } catch {
      /* не критично — пойдём в ignore */
    }
    try {
      child = spawn(electronExe, ["."], { cwd: clientDir, stdio: ["ignore", outFd ?? "ignore", errFd ?? "ignore"], windowsHide: false });
    } catch (e) {
      child = null;
      log("хранитель клиента: спавн упал", { error: String(e?.message ?? e) });
      schedule(backoffMs, "spawn-failed");
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      return;
    } finally {
      // spawn копирует дескрипторы в ребёнка — свои закрываем (иначе утечка fd на каждом рестарте).
      if (outFd !== null) try { closeSync(outFd); } catch { /* уже закрыт */ }
      if (errFd !== null) try { closeSync(errFd); } catch { /* уже закрыт */ }
    }
    startedAt = Date.now();
    log("клиент запущен хранителем", { pid: child.pid });
    child.on("error", (e) => {
      log("хранитель клиента: процесс не поднялся", { error: String(e?.message ?? e) });
      child = null;
      schedule(backoffMs, "spawn-error");
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    });
    child.on("exit", (code, signal) => {
      const uptimeMs = Date.now() - startedAt;
      child = null;
      if (stopping) return;
      const decision = exitDecision({ code, signal, uptimeMs, otherAlive: otherClients().length > 0, ownerQuitMarked: ownerQuitSince(startedAt) });
      if (decision === "owner-quit") {
        ownerQuit = true;
        log("клиент закрыт штатно (код 0) — не перезапускаю до следующего входа в Windows", { uptimeSec: Math.round(uptimeMs / 1000) });
        return;
      }
      if (decision === "watch") {
        watchingSince = Date.now();
        log("клиент уже запущен другим экземпляром — наблюдаю");
        schedule(WATCH_POLL_MS, "watch");
        return;
      }
      if (uptimeMs >= STABLE_UPTIME_MS) backoffMs = BACKOFF_MIN_MS;
      crashes = [...crashes.filter((t) => Date.now() - t < 10 * 60_000), Date.now()];
      log("клиент упал — перезапуск по бэкоффу", { code, signal, uptimeSec: Math.round(uptimeMs / 1000), backoffMs, crashesIn10m: crashes.length });
      if (crashes.length >= 3) {
        void alert(
          "client-crash-loop",
          `клиент (уши и голос) падает подряд — ${crashes.length} раз за 10 минут, код ${code}. Лог: %APPDATA%/@jarvis/client/logs`,
        );
      }
      schedule(backoffMs, "crash");
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    });
  };

  async function tick(why) {
    if (stopping || child || ownerQuit) return;
    if (otherClients().length > 0) {
      if (!watchingSince) watchingSince = Date.now();
      schedule(WATCH_POLL_MS, "watch");
      return;
    }
    if (why === "watch" && ownerQuitSince(watchingSince)) {
      ownerQuit = true;
      log("клиент, запущенный руками, закрыт владельцем («Выйти») — не поднимаю до следующего входа в Windows");
      return;
    }
    // В режиме наблюдения чужой клиент исчез без «Выйти» — подхватываем (это и есть «живёт сам»).
    if (why === "watch") log("чужой экземпляр клиента исчез — поднимаю свой");
    watchingSince = 0;
    spawnClient();
  }

  void tick("start");
  return {
    // Остановка супервизора (рестарт/деплой) клиент НЕ гасит: он независимое приложение и сам переподключится
    // к серверу; новый супервизор увидит живой клиент и перейдёт в наблюдение.
    stop() {
      stopping = true;
      clearTimeout(timer);
    },
  };
}
