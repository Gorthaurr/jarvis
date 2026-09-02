import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertReadable,
  assertWritable,
  isAncestorOfSelf,
  isPolicyConfigPath,
  isProtectedSelfPath,
  isProtectedSelfPathFast,
  isSecretPath,
  isSecretPathFast,
} from "./self-guard.js";

// § рельсы самомодификации: Джарвис правит ИСХОДНИКИ, но не может перезаписать критичное для себя.
describe("self-guard — рельсы самомодификации", () => {
  it("node_modules — запись/удаление запрещены", () => {
    expect(isProtectedSelfPath("C:/proj/node_modules/foo/index.js")).toBe(true);
    expect(() => assertWritable("C:/proj/node_modules/x.js")).toThrow(/самосохранн/i);
  });

  it(".env — секрет: запрещены и запись, и чтение в контекст модели (§0)", () => {
    expect(isSecretPath("C:/proj/.env")).toBe(true);
    expect(isSecretPath("C:/proj/.env.local")).toBe(true);
    expect(() => assertWritable("C:/proj/.env")).toThrow();
    expect(() => assertReadable("C:/proj/.env")).toThrow(/секрет/i);
  });

  it("§sec расширенный denylist секретов: ключи/мастер-ключ/креды/cookie БД — read+write запрещены (M9/H4)", () => {
    for (const s of [
      "C:/Users/anton/.ssh/id_rsa",
      "C:/Users/anton/Desktop/id_rsa",
      "C:/proj/apps/server/data/credentials-master.key",
      "C:/certs/server.pem",
      "C:/certs/private.key",
      "C:/Users/anton/.aws/credentials",
      "C:/Users/anton/AppData/Local/Google/Chrome/User Data/Default/Login Data",
      "C:/Users/anton/.npmrc",
    ]) {
      expect(isSecretPath(s)).toBe(true);
      expect(() => assertReadable(s)).toThrow(/секрет/i);
      expect(() => assertWritable(s)).toThrow();
    }
    // Обычные файлы — НЕ секреты (без ложных срабатываний).
    expect(isSecretPath("C:/proj/notes.txt")).toBe(false);
    expect(isSecretPath("C:/proj/apps/server/src/keymap.ts")).toBe(false);
  });

  it("C2: сама папка секретов (без файла-потомка) тоже защищена — fs_delete{path:'~/.ssh'} не проходит", () => {
    for (const s of [
      "C:/Users/anton/.ssh",
      "C:/Users/anton/.ssh/",
      "C:/Users/anton/.aws",
      "C:/Users/anton/.gnupg",
    ]) {
      expect(isSecretPath(s)).toBe(true);
      expect(() => assertWritable(s)).toThrow();
    }
    // Файлы ВНУТРИ папки по-прежнему ловятся (регресс старого поведения не допускаем).
    expect(isSecretPath("C:/Users/anton/.ssh/known_hosts")).toBe(true);
  });

  it("ИСХОДНИКИ разрешены — их и надо менять для самоулучшения", () => {
    const src = "C:/proj/apps/server/src/brain/agent/index.ts";
    expect(isProtectedSelfPath(src)).toBe(false);
    expect(() => assertWritable(src)).not.toThrow();
    expect(() => assertReadable(src)).not.toThrow();
  });

  it("критичные бинари по имени — защищены", () => {
    expect(isProtectedSelfPath("C:/x/SidecarWin.exe")).toBe(true);
    expect(isProtectedSelfPath("C:/x/electron.exe")).toBe(true);
    expect(isProtectedSelfPath("C:/x/node.exe")).toBe(true);
  });

  it("запущенный бинарь (process.execPath) защищён", () => {
    expect(isProtectedSelfPath(process.execPath)).toBe(true);
  });

  it("волна E (урок Skales): конфиги прав агента — запись запрещена, чтение разрешено", () => {
    for (const p of [
      "C:/proj/mcp.json", // confirm-декларации + команды запуска MCP-детей
      "C:/proj/apps/server/data/consent.json", // согласия §14 — запись = отправки без подтверждения
      "C:/proj/apps/server/data/watches.json", // pendingAction — отложенные поручения
      "C:/proj/apps/server/data/resolutions.json", // роутинг получателей отправок
      "C:/proj/apps/server/data/checkpoints.json", // цель «доделай»
      "C:/proj/apps/server/data/dynamic-tools.json", // выученные инструменты
      "C:/proj/apps/server/data/profile.json", // факты → доверенный блок промпта (только в data/)
      "C:/proj/apps/server/data/tasks.json", // recentTasks → доверенный блок промпта (только в data/)
      "C:/proj/apps/server/data/autonomy-freeze.json", // латч killswitch
      "C:/anywhere/MCP.JSON", // регистронезависимо
    ]) {
      expect(isPolicyConfigPath(p)).toBe(true);
      expect(isProtectedSelfPath(p)).toBe(true); // → ловится и tree-гардом рекурсивного delete/move
      expect(() => assertWritable(p)).toThrow(/прав агента/i);
      expect(() => assertReadable(p)).not.toThrow(); // читать можно — секретов внутри нет
    }
    // Без ложных срабатываний на соседей.
    expect(isPolicyConfigPath("C:/proj/package.json")).toBe(false);
    expect(isPolicyConfigPath("C:/proj/mcp.json.bak")).toBe(false);
  });

  it("контроль-2: generic-имена (tasks/profile.json) НЕ блокируются вне каталога data — кодинг чужих проектов цел", () => {
    // .vscode/tasks.json — типовой файл сборки VSCode: fs_edit по нему легитимен (документированная
    // способность «fs_edit для кодинга»), а блок с причиной «конфиг прав агента» был бы ЛОЖЬЮ.
    for (const p of ["C:/dev/myapp/.vscode/tasks.json", "C:/dev/game/profile.json", "C:/dev/x/src/tasks.json"]) {
      expect(isPolicyConfigPath(p)).toBe(false);
      expect(() => assertWritable(p)).not.toThrow();
    }
    // ...а в каталоге data (стор Джарвиса) — блокируются, вкл. Windows-хвосты.
    expect(isPolicyConfigPath("C:/proj/apps/server/data/tasks.json.")).toBe(true);
    expect(isPolicyConfigPath("D:/backup/data/profile.json")).toBe(true);
  });

  it("контроль-ревью волны E: Windows-хвосты не обходят гард (trailing dot/space, ADS ::$DATA)", () => {
    for (const p of [
      "C:/proj/mcp.json.", // NTFS молча отбрасывает хвостовую точку — файл ТОТ ЖЕ
      "C:/proj/mcp.json ", // ...и хвостовой пробел
      "C:/proj/mcp.json::$DATA", // альтернативный поток того же файла
      "C:/proj/consent.json:stream", // произвольный ADS
    ]) {
      expect(isPolicyConfigPath(p)).toBe(true);
      expect(() => assertWritable(p)).toThrow(/прав агента/i);
    }
    // Та же нормализация — у секретов и критичных бинарей.
    expect(isSecretPath("C:/proj/.env.")).toBe(true);
    expect(isSecretPath("C:/Users/anton/.ssh/id_rsa::$DATA")).toBe(true);
    expect(isProtectedSelfPath("C:/x/node.exe.")).toBe(true);
  });

  // Контроль-3 волны E (HIGH): Windows 8.3 short-name (MCP~1.JSO → mcp.json) обходил денилист по
  // basename — canon (realpathSync.native) разворачивает его для СУЩЕСТВУЮЩЕГО файла. Тест реален
  // только на win32 с включённым 8dot3 на томе; иначе вырождается (не падает).
  const winIt = process.platform === "win32" ? it : it.skip;
  winIt("Windows 8.3 short-name существующего защищённого файла НЕ обходит гард", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-sg83-"));
    try {
      const long = join(dir, "mcp.json");
      writeFileSync(long, "{}", "utf8");
      let shortPath = "";
      try {
        shortPath = execSync(`for %I in ("${long}") do @echo %~sI`, { shell: "cmd.exe" }).toString().trim();
      } catch {
        return; // не смогли добыть короткое имя — среда без поддержки, не проваливаем
      }
      if (!/~\d/.test(shortPath)) return; // 8dot3 выключен на томе → short==long, вектора нет
      // canon внутри lc развернёт short→long → basename mcp.json ∈ POLICY (без фикса было бы false).
      expect(isPolicyConfigPath(shortPath)).toBe(true);
      expect(() => assertWritable(shortPath)).toThrow(/прав агента/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("контроль-4 волны E: fast-варианты (без сисколла) классифицируют basename так же, как канонизирующие", () => {
    // Контроль-5 (MED): путь ОБЯЗАН реально СУЩЕСТВОВАТЬ на диске — на несуществующем canon() внутри
    // lc() ловит ENOENT и возвращает строку как есть, поэтому lc()===lcFast() тривиально ВСЕГДА и
    // тест ничего не доказывает (прошёл бы даже при сломанном canon()). Создаём реальные файлы —
    // именно такие (из fsp.readdir) и текут в горячие циклы fs.ts.
    const dir = mkdtempSync(join(tmpdir(), "jarvis-sgeq-"));
    try {
      const nm = join(dir, "node_modules");
      mkdirSync(nm);
      writeFileSync(join(nm, "x.js"), "1", "utf8");
      writeFileSync(join(dir, ".env"), "K=1", "utf8");
      writeFileSync(join(dir, "notes.txt"), "hi", "utf8");
      const dataDir = join(dir, "data");
      mkdirSync(dataDir);
      writeFileSync(join(dataDir, "mcp.json"), "{}", "utf8");

      for (const p of [join(nm, "x.js"), join(dir, ".env"), join(dataDir, "mcp.json"), join(dir, "notes.txt")]) {
        expect(isProtectedSelfPathFast(p)).toBe(isProtectedSelfPath(p));
        expect(isSecretPathFast(p)).toBe(isSecretPath(p));
      }
      // Обычный файл — оба пути пропускают (без ложных срабатываний).
      expect(isProtectedSelfPathFast(join(dir, "notes.txt"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("аудит [11]: isAncestorOfSelf — предок запущенного бинаря (рекурсивно сносить нельзя)", () => {
    expect(isAncestorOfSelf(dirname(process.execPath))).toBe(true); // папка бинаря — предок
    expect(isAncestorOfSelf(process.execPath)).toBe(true); // сам путь
    expect(isAncestorOfSelf(join(dirname(process.execPath), "no-such-sub"))).toBe(false); // не предок
    expect(isAncestorOfSelf("C:/totally/unrelated/dir")).toBe(false);
  });
});

// § ключи подписи: на машине владельца лежит квалифицированный сертификат физлица с приватным ключом
// (УЦ «Сертум-Про», СНИЛС/ИНН в субъекте) и установлен КриптоПро CSP. Утечь такой ключ в контекст
// модели или снести его нельзя: восстановлению он не подлежит, а подпись им юридически значима.
describe("self-guard — контейнеры ключей Windows/КриптоПро", () => {
  it("хранилища CAPI/CNG (%APPDATA%|%ProgramData%\Microsoft\Crypto) — ни читать, ни писать", () => {
    // Имена ключевых блобов — «<хэш>_<GUID>» БЕЗ расширения: под правило «*.key» они не подпадают,
    // до этого рубежа fs_read выгрузил бы их целиком (пути взяты с реальной машины владельца).
    for (const s of [
      "C:/Users/anton/AppData/Roaming/Microsoft/Crypto/Keys/de7cf8a7901d2ad13e5c67c29e5d1662_d7de515f-a2ae-4a55-acc8-62d0ad953a19",
      "C:/Users/anton/AppData/Roaming/Microsoft/Crypto/RSA/S-1-5-21-458190833-3589952250-1045343621-1001/0a27d063501fc7dbac9620af9c5859c4_d7de515f",
      "C:/ProgramData/Microsoft/Crypto/RSA/MachineKeys/f9416dcf7e0e0f1ec2b7b1d5d1a3f2ce_9b6b",
      "C:/ProgramData/Microsoft/Crypto/SystemKeys/syskey01",
      "C:/Users/anton/AppData/Roaming/Microsoft/Crypto", // сам каталог как конечный путь (fs_delete)
    ]) {
      expect(isSecretPath(s), s).toBe(true);
      expect(isSecretPathFast(s), s).toBe(true); // тот же вердикт в рекурсивном обходе (fs_search/tree-гард)
      expect(() => assertReadable(s)).toThrow(/секрет/i);
      expect(() => assertWritable(s)).toThrow();
    }
  });

  it("контейнеры КриптоПро в каталогах данных — защищены даже без файлов *.key внутри", () => {
    for (const s of [
      "C:/Users/anton/AppData/Local/Crypto Pro/anton.000", // папка-контейнер HDIMAGE-ридера
      "C:/ProgramData/Crypto Pro/Crypto/veselkov.000/primary.key",
      "C:/Users/anton/AppData/Roaming/Crypto Pro/settings.bin",
    ]) {
      expect(isSecretPath(s), s).toBe(true);
      expect(() => assertWritable(s)).toThrow();
    }
  });

  it("границы денилиста: дистрибутив КриптоПро и обычный код про криптографию — НЕ секреты", () => {
    // Блок на «Program Files (x86)/Crypto Pro» сделал бы ложным ответ «установлен ли КриптоПро»,
    // а ключей там нет — только бинари CSP.
    expect(isSecretPath("C:/Program Files (x86)/Crypto Pro/CSP/cpcsp.dll")).toBe(false);
    expect(isSecretPath("C:/proj/src/crypto/signing-notes.md")).toBe(false);
    expect(isSecretPath("C:/proj/microsoft-crypto-readme.txt")).toBe(false);
    expect(isSecretPath("C:/Users/anton/Documents/crypto pro instrukciya.docx")).toBe(false);
  });

  it("сообщение отказа не врёт про «.env», когда речь о контейнере подписи (§1)", () => {
    // Прежний текст утверждал «это .env с ключами» про любой секрет — для контейнера подписи это ложь.
    expect(() => assertReadable("C:/Users/anton/AppData/Roaming/Microsoft/Crypto/Keys/blob_guid")).toThrow(
      /контейнер подписи/i,
    );
  });
});
