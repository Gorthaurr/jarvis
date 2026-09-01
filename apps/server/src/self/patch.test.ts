// Рельсы самоправки (волна I, 2026-08-31). Проверяем ЧИСТУЮ логику ограничителей — git здесь не гоняем.
import { describe, expect, it } from "vitest";
import { PROTECTED_PATHS, branchNameFor, isTestFile, parseNameStatus, parsePorcelain, protectedHits } from "./patch.js";
import { affectedPackages } from "./verify.js";

describe("protectedHits — автономия не снимает собственные ограничители", () => {
  it("ловит попытку тронуть гейты подтверждения и killswitch", () => {
    const hits = protectedHits(["apps/server/src/brain/consent.ts", "apps/server/src/autonomy/freeze.ts", "apps/server/src/voice/pipeline.ts"]);
    expect(hits).toEqual(["apps/server/src/brain/consent.ts", "apps/server/src/autonomy/freeze.ts"]);
  });

  it("ловит сам механизм самоправки (иначе он однажды отредактирует свои рельсы)", () => {
    expect(protectedHits(["apps/server/src/self/patch.ts"])).toHaveLength(1);
    expect(protectedHits(["apps/server/src/self/verify.ts"])).toHaveLength(1);
  });

  it("ловит рельсы записи на клиенте и супервизор", () => {
    expect(protectedHits(["apps/client/main/actuators/self-guard.ts"])).toHaveLength(1);
    expect(protectedHits(["infra/supervisor.mjs"])).toHaveLength(1);
  });

  it("не обходится через обратные слэши Windows и регистр", () => {
    expect(protectedHits(["apps\\server\\src\\brain\\consent.ts"])).toHaveLength(1);
    expect(protectedHits(["Apps/Server/Src/Autonomy/Freeze.ts"])).toHaveLength(1);
  });

  it("ловит любые .env, где бы они ни лежали", () => {
    expect(protectedHits([".env"])).toHaveLength(1);
    expect(protectedHits(["apps/server/.env.local"])).toHaveLength(1);
  });

  it("обычный код правится свободно — рельсы не парализуют работу", () => {
    expect(protectedHits(["apps/server/src/brain/agent/index.ts", "packages/tools/src/index.ts"])).toEqual([]);
  });

  // 🔴 Обход проверки без правки кода: подменить конфигурацию прогона и получить «зелено» на сломанном.
  it.each([
    "vitest.config.ts", // ещё не существует — запрет превентивный: его СОЗДАНИЕ и есть способ обхода
    "apps/server/vitest.config.ts",
    "apps/server/vitest.setup.ts",
    "apps/server/package.json",
    "apps/server/tsconfig.json",
    "package.json",
  ])("не даёт подменить конфигурацию проверки: %s", (p) => {
    expect(protectedHits([p])).toHaveLength(1);
  });

  it("список рельсов не пуст и покрывает четыре класса ограничителей", () => {
    expect(PROTECTED_PATHS.length).toBeGreaterThanOrEqual(10);
    expect(PROTECTED_PATHS.some((p) => p.includes("consent"))).toBe(true);
    expect(PROTECTED_PATHS.some((p) => p.includes("freeze"))).toBe(true);
    expect(PROTECTED_PATHS.some((p) => p.includes("self-guard"))).toBe(true);
    expect(PROTECTED_PATHS.some((p) => p.includes("self/patch"))).toBe(true);
  });
});

describe("branchNameFor — имя ветки безопасно для git", () => {
  it("делает слаг и добавляет дату", () => {
    expect(branchNameFor("Починить дубли в Telegram", "2026-08-31")).toBe("self/2026-08-31-починить-дубли-в-telegram");
  });

  it("выбрасывает опасные символы (пробелы, кавычки, флаги)", () => {
    const b = branchNameFor("--upload-pack='rm -rf /'", "2026-08-31");
    expect(b).toMatch(/^self\/2026-08-31-[a-zа-я0-9-]*$/i);
    expect(b).not.toMatch(/[ '"`;|&$]/);
  });

  it("пустая тема — всё равно валидное имя", () => {
    expect(branchNameFor("", "2026-08-31")).toBe("self/2026-08-31-patch");
  });
});

describe("affectedPackages — тесты гоняем там, где меняли", () => {
  it("правка сервера проверяет сервер", () => {
    expect(affectedPackages(["apps/server/src/x.ts"])).toEqual(["apps/server"]);
  });

  it("правка общего пакета проверяет ОБЕ стороны (ломает и клиент)", () => {
    expect(affectedPackages(["packages/protocol/src/actions.ts"]).sort()).toEqual(["apps/client", "apps/server"]);
  });

  it("правка клиента проверяет клиент", () => {
    expect(affectedPackages(["apps\\client\\main\\actuators\\fs.ts"])).toEqual(["apps/client"]);
  });
});

/**
 * 🔴 Список рельсов — это ТОЧНЫЕ пути, и при переносе файла он молча перестал бы защищать: код
 * уехал, запись осталась, «декларация разошлась с поведением». Тест держит список в соответствии с
 * репозиторием: файл переименовали — тест падает и заставляет обновить рельсы осознанно.
 */
describe("рельсы указывают на существующие файлы", () => {
  it.each(PROTECTED_PATHS.filter((p) => p.endsWith(".ts") || p.endsWith(".mjs")))("%s существует", async (rel) => {
    const { existsSync } = await import("node:fs");
    const { selfRepoRoot } = await import("./repo.js");
    const { join } = await import("node:path");
    expect(existsSync(join(selfRepoRoot(), rel))).toBe(true);
  });
});

/**
 * Изоляция прогона — единственная проверка этого файла, которая смотрит на ТЕКСТ, а не на поведение:
 * поднять временный репозиторий с рабочим тулчейном (tsc+vitest) ради одного факта слишком дорого.
 * Она честно защищает лишь от случайного удаления механизма при рефакторинге; что изоляция РЕАЛЬНО
 * держит, доказано живым прогоном (вредоносный тест не достал боевой data/), а поведение рельсов —
 * в patch-rails.test.ts на настоящем git.
 *
 * 🔴 Прежде здесь лежали ещё две такие grep-проверки на commit/apply. Аудит тестов 2026-09-01 показал
 * их бесполезность: обезвреживание трёх гардов сразу оставляло всю зону зелёной. Они заменены
 * поведенческими тестами, а не удалены.
 */
describe("проверка идёт в одноразовом дереве (защита от случайного удаления механизма)", () => {
  it("verifySelfPatch выкладывает проверяемый коммит в отдельный worktree и не терпит удаления тестов", async () => {
    const { readFileSync } = await import("node:fs");
    const { selfRepoRoot } = await import("./repo.js");
    const { join } = await import("node:path");
    const src = readFileSync(join(selfRepoRoot(), "apps/server/src/self/patch.ts"), "utf8");
    const verify = src.slice(src.indexOf("export async function verifySelfPatch"), src.indexOf("export async function commitSelfPatch"));
    expect(verify).toContain("worktree");
    expect(verify).toContain("removedTests");
  });
});

describe("контроль-2: обходы рельсов", () => {
  it("переименование ограничителя ловится по СТАРОМУ пути (git mv self-guard.ts guard.ts)", () => {
    const files = parsePorcelain("R  apps/client/main/actuators/self-guard.ts -> apps/client/main/actuators/guard.ts");
    expect(files).toContain("apps/client/main/actuators/self-guard.ts");
    expect(protectedHits(files)).toHaveLength(1);
  });

  it("то же в diff --name-status (коммиты ветки)", () => {
    const changed = parseNameStatus("R100\tapps/server/src/brain/consent.ts\tapps/server/src/brain/consent2.ts").map((c) => c.path);
    expect(protectedHits(changed)).toHaveLength(1);
  });

  it("границы чтения своего кода — тоже ограничитель", () => {
    expect(protectedHits(["apps/server/src/self/repo.ts"])).toHaveLength(1);
  });

  it("удалённые тесты опознаются (зелено, купленное удалением проверок)", () => {
    expect(parsePorcelain(" D apps/server/src/self/patch.test.ts", { onlyDeleted: true })).toEqual(["apps/server/src/self/patch.test.ts"]);
    expect(parsePorcelain(" M apps/server/src/self/patch.test.ts", { onlyDeleted: true })).toEqual([]);
    expect(isTestFile("a/b.test.ts")).toBe(true);
    expect(isTestFile("a/b.spec.tsx")).toBe(true);
    expect(isTestFile("a/b.ts")).toBe(false);
  });
});
