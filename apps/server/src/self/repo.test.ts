// Самопознание: границы «своего кода» (волна I, 2026-08-31).
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { compileSearch, isOwnCodePath, looksCatastrophic, readOwnFile, resolveOwnPath, searchOwnCode, selfRepoRoot } from "./repo.js";

describe("selfRepoRoot — Джарвис знает, где он сам", () => {
  it("находит корень монорепозитория (там лежит pnpm-workspace.yaml)", async () => {
    const root = selfRepoRoot();
    expect(root).toBeTruthy();
    // Проверяем по факту: в корне обязан читаться собственный манифест воркспейса.
    const f = await readOwnFile("pnpm-workspace.yaml", { limit: 5 });
    expect(f.lines.join("\n")).toMatch(/packages/);
  });
});

describe("границы чтения — наружу и в личные данные не смотрим", () => {
  const root = selfRepoRoot();

  it("свой исходник — можно", () => {
    expect(isOwnCodePath(join(root, "apps/server/src/self/repo.ts"))).toBe(true);
  });

  it.each([
    ["выход за пределы репозитория", join(root, "..", "..", "secrets.txt")],
    ["личные данные владельца (data/)", join(root, "apps/server/data/profile.json")],
    ["зависимости", join(root, "node_modules/foo/index.js")],
    ["история git", join(root, ".git/config")],
    ["секреты", join(root, ".env")],
    ["ключ", join(root, "apps/server/id_rsa")],
  ])("%s — нельзя", (_name, p) => {
    expect(isOwnCodePath(p)).toBe(false);
  });

  it("resolveOwnPath отвергает выход через ..", () => {
    expect(resolveOwnPath("../../../etc/passwd")).toBeUndefined();
    expect(resolveOwnPath("apps/server/src/self/repo.ts")).toBeTruthy();
  });

  it("чтение запретного пути — честная ошибка, а не пустой результат", async () => {
    await expect(readOwnFile("../secret.txt")).rejects.toThrow(/вне моего кода/);
  });
});

describe("readOwnFile — окно строк с номерами", () => {
  it("отдаёт запрошенное окно и говорит, что файл длиннее", async () => {
    const f = await readOwnFile("apps/server/src/self/repo.ts", { from: 1, limit: 5 });
    expect(f.lines.length).toBe(5);
    expect(f.totalLines).toBeGreaterThan(5);
    expect(f.truncated).toBe(true);
    expect(f.path).toBe("apps/server/src/self/repo.ts"); // путь нормализован к слэшам
  });
});

describe("searchOwnCode — поиск по себе", () => {
  it("находит собственный маркер в собственном каталоге", async () => {
    const r = await searchOwnCode("selfRepoRoot", { dir: "apps/server/src/self", maxHits: 20 });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.path.startsWith("apps/server/src/self"))).toBe(true);
  });

  it("невалидная регулярка не роняет поиск (ищется как текст)", async () => {
    const r = await searchOwnCode("selfRepoRoot(", { dir: "apps/server/src/self", maxHits: 5 });
    expect(r.hits.length).toBeGreaterThan(0);
  });

  it("каталог вне репозитория — отказ, а не молчаливый пустой ответ", async () => {
    await expect(searchOwnCode("token", { dir: "../../.." })).rejects.toThrow(/вне моего кода/);
  });

  it("уважает потолок совпадений и честно сообщает об усечении", async () => {
    const r = await searchOwnCode("import", { dir: "apps/server/src/self", maxHits: 2 });
    expect(r.hits.length).toBe(2);
    expect(r.capped).toBe(true);
  });
});

// ─── Обходы границ (найдено адверс-ревью волны I, 2026-08-31) ───
describe("обходы границ чтения", () => {
  const root = selfRepoRoot();

  // 🔴 На Windows «Data» и «data» — ОДИН каталог: регистрозависимый денилист обходился одним символом,
  // открывая личные данные владельца (профиль, память, чекпойнты) через self_code_read.
  it.each(["apps/server/Data/profile.json", "apps/server/DATA/memory/x.json", "Node_Modules/pkg/i.js", ".GIT/config"])(
    "смена регистра не открывает закрытую зону: %s",
    (p) => {
      expect(resolveOwnPath(p)).toBeUndefined();
    },
  );

  it("junction внутри репозитория, ведущий НАРУЖУ, не читается", async () => {
    const { mkdirSync, rmSync, symlinkSync } = await import("node:fs");
    const linkDir = join(root, "apps/server/src/_test_link_dir");
    const link = join(linkDir, "outside");
    rmSync(linkDir, { recursive: true, force: true });
    mkdirSync(linkDir, { recursive: true });
    try {
      // junction не требует прав администратора (в отличие от symlink) — тот же приём, что в self-guard.
      symlinkSync(join(root, ".."), link, "junction");
    } catch {
      return; // ФС не дала создать ссылку — проверять нечего
    }
    try {
      // Путь ВНУТРИ репозитория по написанию, но канонически — за его пределами.
      expect(resolveOwnPath("apps/server/src/_test_link_dir/outside/CLAUDE.md")).toBeUndefined();
      // И обход по ссылке не ходит: поиск не должен вывалиться наружу репозитория.
      const r = await searchOwnCode("CLAUDE", { dir: "apps/server/src/_test_link_dir", maxHits: 5 });
      expect(r.hits.every((h) => !h.path.includes("outside"))).toBe(true);
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
    }
  });
});

// ─── ReDoS: паттерн приходит ОТ МОДЕЛИ (адверс-ревью волны I) ───
describe("поиск по коду не вешает сервер вредной регуляркой", () => {
  it("распознаёт вложенные квантификаторы", () => {
    expect(looksCatastrophic("(a+)+$")).toBe(true);
    expect(looksCatastrophic("(\s*\w*)*")).toBe(true);
    expect(looksCatastrophic("probeTelegramDelivery")).toBe(false);
    expect(looksCatastrophic("function\s+\w+")).toBe(false); // обычный рабочий паттерн живёт
  });

  it("опасное выражение ищется как ТЕКСТ (поиск работает, процесс жив)", () => {
    const re = compileSearch("(a+)+$");
    expect(re.test("(a+)+$")).toBe(true); // литеральное совпадение
    expect(re.test("aaaaaaaaaaaaaaaaaaaaaaaaaaX")).toBe(false); // как регулярка НЕ применяется
  });

  it("катастрофический паттерн по реальному коду отрабатывает быстро", async () => {
    const started = Date.now();
    // Без фикса это экспоненциальный бэктрекинг на первой же длинной строке — сервер (и голос) встают.
    await searchOwnCode("(x+x+)+y", { dir: "apps/server/src", maxHits: 5 });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("обычная регулярка по-прежнему работает как регулярка", () => {
    expect(compileSearch(String.raw`export\s+function`).test("export function foo()")).toBe(true);
  });
});
