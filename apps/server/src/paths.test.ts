import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataDir, dataPath } from "./paths.js";

describe("dataDir/dataPath — универсальность (инсталлер на любой машине)", () => {
  afterEach(() => {
    delete process.env.JARVIS_DATA_DIR;
  });

  it("без env → дефолт cwd/data (поведение dev НЕ меняется, данные не теряются)", () => {
    delete process.env.JARVIS_DATA_DIR;
    expect(dataDir()).toBe(join(process.cwd(), "data"));
    expect(dataPath("memory")).toBe(join(process.cwd(), "data", "memory"));
  });

  it("JARVIS_DATA_DIR переопределяет (инсталлер → %APPDATA%/Jarvis)", () => {
    process.env.JARVIS_DATA_DIR = "D:\\AppData\\Jarvis";
    expect(dataDir()).toBe("D:\\AppData\\Jarvis");
    expect(dataPath("tasks.json")).toBe(join("D:\\AppData\\Jarvis", "tasks.json"));
  });

  it("пустой/пробельный env → дефолт (не ломаемся на кривом значении)", () => {
    process.env.JARVIS_DATA_DIR = "   ";
    expect(dataDir()).toBe(join(process.cwd(), "data"));
  });
});
