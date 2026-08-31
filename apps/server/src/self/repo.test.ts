// Самопознание: границы «своего кода» (волна I, 2026-08-31).
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { isOwnCodePath, readOwnFile, resolveOwnPath, searchOwnCode, selfRepoRoot } from "./repo.js";

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
