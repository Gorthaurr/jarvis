// Рельсы самоправки (волна I, 2026-08-31). Проверяем ЧИСТУЮ логику ограничителей — git здесь не гоняем.
import { describe, expect, it } from "vitest";
import { PROTECTED_PATHS, branchNameFor, parsePorcelain, protectedHits } from "./patch.js";
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
 * 🔴 Ревью волны I (HIGH): зелёная проверка относится к КОНКРЕТНОМУ содержимому. Между verify и
 * commit модель могла дописать что угодно — включая снятие собственных ограничителей, — и `git add -A`
 * утащил бы это в коммит под отчётом «проверено, зелено».
 */
describe("рельсы перепроверяются на КАЖДОМ шаге, а не только при verify", () => {
  it("commit и apply вызывают проверку рельсов и сверку отпечатка", async () => {
    const { readFileSync } = await import("node:fs");
    const { selfRepoRoot } = await import("./repo.js");
    const { join } = await import("node:path");
    const src = readFileSync(join(selfRepoRoot(), "apps/server/src/self/patch.ts"), "utf8");
    const commit = src.slice(src.indexOf("export async function commitSelfPatch"), src.indexOf("export async function applySelfPatch"));
    const apply = src.slice(src.indexOf("export async function applySelfPatch"), src.indexOf("export async function abortSelfPatch"));
    for (const [name, body] of [["commit", commit], ["apply", apply]] as const) {
      expect(body, `${name} обязан перепроверять рельсы`).toContain("protectedHits");
      expect(body, `${name} обязан сверять отпечаток проверенного дерева`).toContain("verifiedFingerprint");
    }
  });

  it("apply не применяет правку без отметки о пройденной проверке", async () => {
    const { readFileSync } = await import("node:fs");
    const { selfRepoRoot } = await import("./repo.js");
    const { join } = await import("node:path");
    const src = readFileSync(join(selfRepoRoot(), "apps/server/src/self/patch.ts"), "utf8");
    expect(src).toContain("нет отметки о пройденной проверке");
  });
});

/**
 * 🔴 Найдено ЖИВЫМ прогоном цикла (тесты гард на готовых списках не ловили): вывод git обрезался
 * общим trim(), из-за чего у ПЕРВОЙ строки porcelain пропадал ведущий пробел кода состояния, разбор
 * съезжал на символ, и путь приезжал как «pps/server/...». Гард ограничителей такой путь не узнавал —
 * то есть правку killswitch можно было пронести мимо рельсов, если она первая в списке.
 */
describe("parsePorcelain — разбор состояния репозитория", () => {
  it("незастейдженная правка (ведущий пробел) читается ПОЛНОСТЬЮ", () => {
    expect(parsePorcelain(" M apps/server/src/autonomy/freeze.ts\n")).toEqual(["apps/server/src/autonomy/freeze.ts"]);
  });

  it("и такой путь ловится рельсами (сквозная проверка того самого сценария)", () => {
    expect(protectedHits(parsePorcelain(" M apps/server/src/autonomy/freeze.ts"))).toHaveLength(1);
  });

  it("разные состояния: добавлен, удалён, неотслеживаемый, переименован", () => {
    const raw = ["A  apps/server/src/new.ts", " D apps/server/src/old.ts", "?? apps/server/src/untracked.ts", "R  a/old.ts -> a/new.ts"].join("\n");
    expect(parsePorcelain(raw)).toEqual(["apps/server/src/new.ts", "apps/server/src/old.ts", "apps/server/src/untracked.ts", "a/new.ts"]);
  });

  it("путь в кавычках (кириллица при core.quotepath) разворачивается", () => {
    expect(parsePorcelain(' M "apps/server/src/файл.ts"')).toEqual(["apps/server/src/файл.ts"]);
  });

  it("пустой вывод — пустой список (чистое дерево)", () => {
    expect(parsePorcelain("")).toEqual([]);
    expect(parsePorcelain("\n\n")).toEqual([]);
  });
});
