// Рельсы самоправки (волна I, 2026-08-31). Проверяем ЧИСТУЮ логику ограничителей — git здесь не гоняем.
import { describe, expect, it } from "vitest";
import { PROTECTED_PATHS, branchNameFor, protectedHits } from "./patch.js";
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
