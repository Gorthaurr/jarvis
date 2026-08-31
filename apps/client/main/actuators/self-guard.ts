/**
 * Рельсы самомодификации (§ самоулучшение): Джарвис может править СВОЙ код (исходники в каталогах
 * src внутри apps и packages), чтобы улучшать себя, — но НЕ должен сломать себя или утечь секреты.
 *
 * Этот guard — ПОСЛЕДНИЙ рубеж на клиенте (там, где реально лежат файлы и крутится процесс):
 * даже если модель/сервер ошиблись, клиент защищает сам себя. Зависимости только node:path/node:fs
 * (realpathSync для канонизации) + global process, без electron — чтобы юнит-тесты не тянули нативный модуль.
 *
 * Защищаем (HARD refuse на запись/удаление/перемещение):
 *   - node_modules — зависимости; правка/удаление ломает рантайм;
 *   - .env / .env.* — секреты (§0): и писать, и ЧИТАТЬ в контекст модели нельзя;
 *   - запущенный бинарь (process.execPath) и критичные exe (electron/node/SidecarWin).
 * РАЗРЕШЕНО: исходники (каталоги src в apps и packages) — их и надо менять для самоулучшения,
 * затем пересборка. Менять собранный dist «на лету» бессмысленно (его перезапишет сборка).
 */
import { realpathSync } from "node:fs";
import { basename, resolve, sep } from "node:path";

const canon = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

/**
 * Контроль-3 волны E (HIGH, урок Skales + живой `dir /x`): Windows-денилист обходился 8.3 short-name —
 * `MCP~1.JSO` резолвится NTFS в `mcp.json`, но по basename не совпадал (расширение .json >3 симв. →
 * короткое имя есть ВСЕГДА). realpathSync.native разворачивает 8.3 (а заодно symlink/junction/регистр)
 * в КАНОН — и денилист снова целен. Работает только для СУЩЕСТВУЮЩИХ путей, но вектор обхода как раз
 * перезапись/удаление/перемещение существующего защищённого файла; у несуществующей цели 8.3-alias'а
 * не бывает (короткое имя генерится лишь при создании реального длинного). Провал (нет пути) → исходная
 * строка (для create-кейса безопасно).
 *
 * 🔴 ДОРОГОЕ: `realpathSync.native` — синхронный блокирующий сисколл (Windows: открыть хэндл +
 * `GetFinalPathNameByHandleW`). Звать его нужно РОВНО ОДИН РАЗ на ВНЕШНИЙ путь (аргумент от
 * инструмента/LLM — единственный реальный носитель 8.3-обхода), а НЕ на каждую запись при
 * рекурсивном обходе дерева (контроль-4: `fs_delete{recursive}`/`fs_move`/`fs_search` гоняли этот
 * сисколл до 200 000 раз на одну операцию, вдобавок избыточно 5-7× НА ОДИН вызов из-за внутренней
 * композиции проверок — суммарно до ~1 млн блокирующих вызовов, замораживающих Electron main-процесс
 * на секунды-минуты, а на сетевом диске/OneDrive — вплоть до SMB-таймаута). Дочерние записи
 * `fsp.readdir()` УЖЕ канонические длинные имена (Windows readdir не отдаёт 8.3-алиасы) — им
 * канонизация не нужна, для них есть `*Fast`-варианты ниже (обычный `resolve+toLowerCase`, как было
 * ДО контроль-3). Топ-уровневый путь операции по-прежнему проходит через канонизирующие функции.
 */
const lc = (p: string): string => resolve(canon(p)).toLowerCase();
/** Дешёвая нормализация БЕЗ сисколла — для уже-канонических путей (записи readdir в горячих циклах). */
const lcFast = (p: string): string => resolve(p).toLowerCase();

/** `process.execPath` неизменен всю жизнь процесса — канонизируем ЛЕНИВО и РОВНО ОДИН РАЗ. */
let execPathLcCache: string | undefined;
function execPathLc(): string {
  if (execPathLcCache === undefined) {
    try {
      execPathLcCache = lc(process.execPath);
    } catch {
      execPathLcCache = resolve(process.execPath).toLowerCase();
    }
  }
  return execPathLcCache;
}

/**
 * Нормализация ПОСЛЕДНЕЙ компоненты УЖЕ НОРМАЛИЗОВАННОГО пути (`lc`/`lcFast` применены вызывающим —
 * здесь БЕЗ повторного сисколла) против Windows-трюков: NTFS молча отбрасывает хвостовые точки/
 * пробелы («mcp.json. » открывает mcp.json), а `mcp.json::$DATA` — альтернативный поток ТОГО ЖЕ
 * файла. Двоеточия в настоящем имени файла Windows не бывает → всё после первого ':' отрезаем.
 */
function normalizedBasenameOf(normalized: string): string {
  let b = basename(normalized);
  const colon = b.indexOf(":");
  if (colon >= 0) b = b.slice(0, colon);
  return b.replace(/[. ]+$/u, "");
}

const CRITICAL_BASENAMES = new Set(["sidecarwin.exe", "electron.exe", "node.exe"]);

/**
 * Волна E (урок Skales «самоснимаемая песочница»): файлы, определяющие ПРАВА, ОТЛОЖЕННЫЕ ДЕЙСТВИЯ и
 * ДОВЕРЕННЫЙ КОНТЕКСТ самого агента. Если fs_write может их править, агент (или prompt-injection
 * через него) снимает собственные гейты: mcp.json несёт confirm-декларации, toolEffect И КОМАНДЫ
 * ЗАПУСКА MCP-детей (запись = произвольный запуск при boot); consent.json — согласия §14 (запись =
 * отправки БЕЗ подтверждения владельца); watches.json несёт pendingAction (исполнится машинным
 * реэнтри от имени владельца); checkpoints.json — цель «доделай» (запись = чужая цель в резюме);
 * resolutions.json роутит получателей («Кате» → подменённый peer); dynamic-tools.json — выученные
 * инструменты; profile.json/tasks.json попадают в ДОВЕРЕННЫЙ блок промпта (отмывка инъекции в факт);
 * autonomy-freeze.json — латч killswitch (удаление = самоснятие стопа).
 * Запись/удаление/перемещение — только владелец руками (или code_run по его явной просьбе —
 * code_run НАМЕРЕННО мощный по политике §sec, этот рубеж закрывает fs_*-путь, основной для инъекций).
 * Чтение НЕ блокируем (секретов в них нет — ${ENV} в mcp.json не резолвится на диске).
 * ⚠️ Осознанный предел basename-подхода: партиционированные сторы с uuid-именами (data/profile/<id>.json)
 * им не закрыть — корневой фикс «запрет записи во весь dataDir» отложен (клиент не знает серверный
 * JARVIS_DATA_DIR; трек в docs/SKALES_ADOPTION_2026-08-07.md).
 */
const POLICY_BASENAMES = new Set([
  "mcp.json",
  "consent.json",
  "watches.json",
  "resolutions.json",
  "checkpoints.json",
  "dynamic-tools.json",
  "autonomy-freeze.json",
]);

/**
 * Контроль-2 волны E: у tasks.json/profile.json имена ОБЩЕУПОТРЕБИМЫЕ (`.vscode/tasks.json` — типовой
 * файл сборки, который владелец legitimately правит через Джарвиса; profile.json — частое имя в чужих
 * проектах) — глобальный basename-матч ломал кодинг с ЛОЖНОЙ причиной «конфиг прав агента» и валил
 * рекурсивный delete/move целых папок через tree-гард. Эти два блокируются ТОЛЬКО в каталоге `data`
 * (родитель = data — дефолтный стор Джарвиса apps/server/data/*). Кастомный JARVIS_DATA_DIR вне
 * каталога с именем data этим не закрыт — тот же осознанный предел, что и uuid-сторы (см. шапку).
 */
const POLICY_DATA_BASENAMES = new Set(["profile.json", "tasks.json"]);

/**
 * Волна F (адверс-ревью): ПАРТИЦИОНИРОВАННЫЕ сторы того же класса — имя содержит userId, поэтому
 * basename-множеством их не закрыть, но ПРЕФИКС предсказуем (у single-user установки — тем более).
 *  • `fact-meta-<user>.jsonl` — провенанс фактов профиля: запись = подделка источника («вы сами»)
 *    в витрине честности, т.е. отмывание инъекции в максимальное доверие владельца;
 *  • `consolidation-<user>.jsonl` — журнал сон-цикла: запись = фальшивый отчёт о том, что Джарвис
 *    записал в память ночью; удаление = сокрытие сработавшего анти-инъекционного фильтра;
 *  • `evicted-<user>.jsonl` — durable-архив вытесненных фактов (витрина «ничего не пропало молча»).
 * Плюс каталог карантина навыков `_quarantine` — это УЛИКИ заблокированной инъекции (F2): их
 * удаление стирает след атаки. Все — только для записи/удаления; чтение не блокируем.
 */
const POLICY_DATA_PREFIXES = ["fact-meta-", "consolidation-", "evicted-"];

// ── Проверки НАД УЖЕ НОРМАЛИЗОВАННЫМ путём (без сисколлов) — общее ядро для canon- и fast-веток. ──

function isSecretPathNorm(normalized: string): boolean {
  const b = normalizedBasenameOf(normalized);
  if (b === ".env" || b.startsWith(".env.")) return true;
  if (b === "credentials-master.key" || b === "id_rsa" || b === "id_dsa" || b === "id_ecdsa" || b === "id_ed25519") return true;
  if (b === ".npmrc" || b === ".netrc" || b === "credentials") return true; // npm/aws-creds/netrc
  if (/\.(pem|key|ppk|pfx|p12|keystore|jks)$/.test(b)) return true; // приватные ключи/хранилища
  if (b === "login data" || b === "cookies" || b === "cookies.sqlite" || b === "key4.db" || b === "logins.json") return true; // браузерные креды
  // Каталоги секретов целиком: ~/.ssh, ~/.aws, ~/.gnupg — и файлы/подпапки ВНУТРИ них, и сама
  // папка как конечный путь (fs_delete{path:'~/.ssh'} — разделителя ПОСЛЕ имени нет, конец строки).
  if (/[\\/]\.(?:ssh|aws|gnupg)(?:[\\/]|$)/.test(normalized)) return true;
  return false;
}

function isPolicyConfigPathNorm(normalized: string): boolean {
  const b = normalizedBasenameOf(normalized);
  if (POLICY_BASENAMES.has(b)) return true;
  // Generic-имена — только внутри каталога data (иначе ломали бы чужие проекты, контроль-2).
  if (POLICY_DATA_BASENAMES.has(b) && /[\\/]data[\\/][^\\/]+$/.test(normalized)) return true;
  // Волна F: партиционированные сторы провенанса/журналов — по префиксу и только под каталогом data
  // (тот же гард «не ломать чужие проекты»: путь обязан лежать внутри …/data/…).
  if (/[\\/]data[\\/]/.test(normalized) && POLICY_DATA_PREFIXES.some((p) => b.startsWith(p) && b.endsWith(".jsonl"))) return true;
  // Карантин навыков (улики заблокированной инъекции, F2) — каталог целиком.
  if (/[\\/]data[\\/]skills[\\/]_quarantine(?:[\\/]|$)/.test(normalized)) return true;
  return false;
}

function isProtectedSelfPathNorm(normalized: string): boolean {
  if (normalized.split(/[\\/]+/).includes("node_modules")) return true; // зависимости
  if (isSecretPathNorm(normalized)) return true; // секреты (§0)
  if (CRITICAL_BASENAMES.has(normalizedBasenameOf(normalized))) return true; // критичные бинари
  if (isPolicyConfigPathNorm(normalized)) return true; // конфиги прав самого агента (волна E)
  if (normalized === execPathLc()) return true; // сам запущенный бинарь
  return false;
}

// ── Публичное КАНОНИЗИРУЮЩЕЕ API (топ-уровневый путь операции — единственный носитель 8.3-обхода). ──

/**
 * Секретный файл: и писать, и читать в контекст модели запрещено (§0/§sec). Помимо .env —
 * приватные ключи, мастер-ключ шифрования, SSH-ключи, креды облака/npm, БД cookie/логинов браузера
 * (M9/H4): иначе prompt-injection → fs_read «id_rsa»/«credentials-master.key»/«Login Data» → эксфильтрация.
 */
export function isSecretPath(abs: string): boolean {
  return isSecretPathNorm(lc(abs));
}

/**
 * Контроль-5 волны E (HIGH): канонизировать путь ОДИН РАЗ (сисколл) — для мест, где ОБХОД строится
 * ОТ базы, потенциально подверженной 8.3/symlink/junction-алиасу (`fs_search{root}`). У delete/move
 * топ-путь уже канонизируется неявно через `assertWritable(abs)` ДО начала обхода — у search() такой
 * проверки не было вовсе, и до контроль-4 её случайно закрывал полный `canon()` на КАЖДОЙ дочерней
 * записи (realpath резолвит ВСЮ цепочку каталогов, включая junction где угодно в пути). После замены
 * per-entry проверки на `*Fast` (без сисколла, контроль-4) эта побочная защита исчезла именно для
 * search(): `full = join(root, d.name)`, построенный от НЕканонического алиаса, не содержит литеральной
 * `.ssh`/`.aws`/`.gnupg` даже если ЦЕЛЬ алиаса — секретный каталог, и per-entry regex не срабатывает.
 * Канонизировать корень ОДИН раз (не на каждую запись) восстанавливает защиту без потери перфа.
 * Несуществующий путь → возвращается как есть (create-кейс/уже-упавший readdir безопасны).
 */
export function canonicalizePath(abs: string): string {
  return canon(abs);
}

/** Конфиг прав/отложенных действий агента — писать через инструменты нельзя (см. POLICY_BASENAMES). */
export function isPolicyConfigPath(abs: string): boolean {
  return isPolicyConfigPathNorm(lc(abs));
}

/** Критичный для самосохранности путь — запись/удаление/перемещение запрещены. */
export function isProtectedSelfPath(abs: string): boolean {
  return isProtectedSelfPathNorm(lc(abs));
}

/**
 * Аудит ядра [11]: является ли `abs` предком (или равен каталогом) запущенного бинаря Джарвиса.
 * Рекурсивное удаление/перемещение такого каталога снесло бы сам бинарь → отказываем.
 */
export function isAncestorOfSelf(abs: string): boolean {
  try {
    const dir = lc(abs);
    return execPathLc() === dir || execPathLc().startsWith(dir + sep);
  } catch {
    return false;
  }
}

// ── БЫСТРЫЕ варианты БЕЗ канонизации — ТОЛЬКО для записей рекурсивного обхода (fs.ts). ──────────────
// `fsp.readdir()` отдаёт канонические длинные имена (Windows не возвращает 8.3-алиасы из листинга),
// поэтому пере-канонизировать каждую запись НЕ нужно — топ-путь операции уже прошёл `isProtectedSelfPath`/
// `assertWritable` (канонизирующие) ДО начала обхода. CRITICAL_BASENAMES/POLICY/секреты по basename
// ловятся тут так же надёжно; единственное, чего Fast-путь не даёт — резолва СИМЛИНКА-потомка на
// защищённую цель (симлинк внутри дерева — отдельный, не 8.3, класс угрозы; вне объёма контроль-3).

/** Быстрый (без сисколла) аналог `isSecretPath` — для проверки КАЖДОЙ записи при обходе (fs_search). */
export function isSecretPathFast(abs: string): boolean {
  return isSecretPathNorm(lcFast(abs));
}

/** Быстрый (без сисколла) аналог `isProtectedSelfPath` — для проверки КАЖДОЙ записи (tree-гард delete/move). */
export function isProtectedSelfPathFast(abs: string): boolean {
  return isProtectedSelfPathNorm(lcFast(abs));
}

/** Бросить, если в защищённую зону пытаются ПИСАТЬ/удалять/перемещать. */
export function assertWritable(abs: string): void {
  if (isPolicyConfigPath(abs)) {
    throw new Error(
      `защита прав агента (§sec, волна E): «${abs}» — конфиг прав/отложенных действий Джарвиса (confirm-гейты MCP, отложенные поручения, роутинг получателей). Инструментами его менять нельзя — только владелец руками.`,
    );
  }
  if (isProtectedSelfPath(abs)) {
    throw new Error(
      `защита самосохранности (§): «${abs}» критичен для работы Джарвиса (node_modules / .env / запущенный бинарь) — менять нельзя. Правь ИСХОДНИКИ (apps/*/src, packages/*/src), затем пересборка/перезапуск.`,
    );
  }
}

/** Бросить, если пытаются ЧИТАТЬ секрет (.env) — не утекаем ключи в контекст модели (§0). */
export function assertReadable(abs: string): void {
  if (isSecretPath(abs)) {
    throw new Error(`защита секретов (§0): «${abs}» — .env с ключами, читать его в контекст нельзя.`);
  }
}
