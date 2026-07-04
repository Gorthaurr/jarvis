import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEnvCandidates, findEnvFile } from "./env-path.js";

describe("buildEnvCandidates — устойчивый поиск .env (универсальность инсталлера)", () => {
  it("JARVIS_ENV_PATH — высший приоритет (явный путь инсталлера/CI)", () => {
    const c = buildEnvCandidates({ env: { JARVIS_ENV_PATH: "X:/cfg/.env" }, cwd: "/proj" });
    expect(c[0]).toBe("X:/cfg/.env");
  });
  it("%APPDATA%/Jarvis/.env включён (куда кладёт инсталлер, как dataDir)", () => {
    const c = buildEnvCandidates({ env: { APPDATA: "C:/Users/Иван/AppData/Roaming" }, cwd: "/p" });
    expect(c).toContain(join("C:/Users/Иван/AppData/Roaming", "Jarvis", ".env"));
  });
  it("дефолт всегда содержит cwd/.env и ../.env (dev)", () => {
    const c = buildEnvCandidates({ env: {}, cwd: "/proj" });
    expect(c).toContain(resolve("/proj", ".env"));
    expect(c).toContain(resolve("/proj", "..", ".env"));
  });
  it("дедуп, без пустых", () => {
    const c = buildEnvCandidates({ env: { JARVIS_ENV_PATH: resolve("/proj", ".env") }, cwd: "/proj" });
    expect(c.filter((p) => p === resolve("/proj", ".env"))).toHaveLength(1);
  });
});

describe("findEnvFile", () => {
  it("возвращает ПЕРВЫЙ существующий (инъекция exists)", () => {
    expect(findEnvFile(["/a/.env", "/b/.env", "/c/.env"], (p) => p === "/b/.env")).toBe("/b/.env");
  });
  it("нет существующих → undefined", () => {
    expect(findEnvFile(["/a/.env"], () => false)).toBeUndefined();
  });
});
