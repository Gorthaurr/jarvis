/**
 * Рельсы самомодификации (§ самоулучшение): Джарвис может править СВОЙ код (исходники в каталогах
 * src внутри apps и packages), чтобы улучшать себя, — но НЕ должен сломать себя или утечь секреты.
 *
 * Этот guard — ПОСЛЕДНИЙ рубеж на клиенте (там, где реально лежат файлы и крутится процесс):
 * даже если модель/сервер ошиблись, клиент защищает сам себя. Чистый (только node:path + global
 * process), без electron — чтобы юнит-тесты не тянули нативный модуль.
 *
 * Защищаем (HARD refuse на запись/удаление/перемещение):
 *   - node_modules — зависимости; правка/удаление ломает рантайм;
 *   - .env / .env.* — секреты (§0): и писать, и ЧИТАТЬ в контекст модели нельзя;
 *   - запущенный бинарь (process.execPath) и критичные exe (electron/node/SidecarWin).
 * РАЗРЕШЕНО: исходники (каталоги src в apps и packages) — их и надо менять для самоулучшения,
 * затем пересборка. Менять собранный dist «на лету» бессмысленно (его перезапишет сборка).
 */
import { basename, resolve } from "node:path";

const lc = (p: string): string => resolve(p).toLowerCase();

/**
 * Секретный файл: и писать, и читать в контекст модели запрещено (§0/§sec). Помимо .env —
 * приватные ключи, мастер-ключ шифрования, SSH-ключи, креды облака/npm, БД cookie/логинов браузера
 * (M9/H4): иначе prompt-injection → fs_read «id_rsa»/«credentials-master.key»/«Login Data» → эксфильтрация.
 */
export function isSecretPath(abs: string): boolean {
  const p = lc(abs);
  const b = basename(p);
  if (b === ".env" || b.startsWith(".env.")) return true;
  if (b === "credentials-master.key" || b === "id_rsa" || b === "id_dsa" || b === "id_ecdsa" || b === "id_ed25519") return true;
  if (b === ".npmrc" || b === ".netrc" || b === "credentials") return true; // npm/aws-creds/netrc
  if (/\.(pem|key|ppk|pfx|p12|keystore|jks)$/.test(b)) return true; // приватные ключи/хранилища
  if (b === "login data" || b === "cookies" || b === "cookies.sqlite" || b === "key4.db" || b === "logins.json") return true; // браузерные креды
  // Каталоги секретов целиком: ~/.ssh, ~/.aws, ~/.gnupg — и файлы/подпапки ВНУТРИ них, и сама
  // папка как конечный путь (fs_delete{path:'~/.ssh'} — разделителя ПОСЛЕ имени нет, конец строки).
  if (/[\\/]\.(?:ssh|aws|gnupg)(?:[\\/]|$)/.test(p)) return true;
  return false;
}

const CRITICAL_BASENAMES = new Set(["sidecarwin.exe", "electron.exe", "node.exe"]);

/** Критичный для самосохранности путь — запись/удаление/перемещение запрещены. */
export function isProtectedSelfPath(abs: string): boolean {
  const p = lc(abs);
  if (p.split(/[\\/]+/).includes("node_modules")) return true; // зависимости
  if (isSecretPath(p)) return true; // секреты (§0)
  if (CRITICAL_BASENAMES.has(basename(p))) return true; // критичные бинари
  try {
    if (p === lc(process.execPath)) return true; // сам запущенный бинарь
  } catch {
    /* нет execPath — пропускаем */
  }
  return false;
}

/** Бросить, если в защищённую зону пытаются ПИСАТЬ/удалять/перемещать. */
export function assertWritable(abs: string): void {
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
