import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataDir, dataPath, lazyDataPath, resetLazyPathsForTests } from "./paths.js";

const saved = process.env.JARVIS_DATA_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.JARVIS_DATA_DIR;
  else process.env.JARVIS_DATA_DIR = saved;
  resetLazyPathsForTests();
});

describe("dataDir / dataPath", () => {
  it("JARVIS_DATA_DIR перекрывает дефолт cwd/data", () => {
    process.env.JARVIS_DATA_DIR = "D:/jarvis-data";
    expect(dataDir()).toBe("D:/jarvis-data");
    expect(dataPath("memory")).toBe(join("D:/jarvis-data", "memory"));
  });

  it("без env — cwd/data (существующие dev-установки не теряют данные)", () => {
    delete process.env.JARVIS_DATA_DIR;
    expect(dataDir()).toBe(join(process.cwd(), "data"));
  });
});

// 🔴 Волна E (найдено ЖИВЫМ прогоном): сторы вычисляли путь на ВЕРХНЕМ УРОВНЕ модуля, а ESM хойстит
// импорты ВЫШЕ loadEnv() в index.ts → JARVIS_DATA_DIR из .env был МЁРТВОЙ настройкой. Для инсталлера
// (%APPDATA%/Jarvis/.env) это означало бы данные в read-only C:\Program Files\… и молчаливую потерю
// профиля/памяти/навыков. lazyDataPath считает путь при ПЕРВОМ ОБРАЩЕНИИ — то есть уже после .env.
describe("lazyDataPath — путь берётся при обращении, а не на импорте", () => {
  it("env, выставленный ПОСЛЕ создания резолвера, применяется", () => {
    delete process.env.JARVIS_DATA_DIR;
    const p = lazyDataPath("skills"); // «импорт модуля» — env ещё не загружен
    process.env.JARVIS_DATA_DIR = "D:/late-env"; // «loadEnv() из .env» происходит позже
    expect(p()).toBe(join("D:/late-env", "skills")); // до фикса здесь был бы cwd/data/skills
  });

  it("значение кешируется: путь стора не «плавает» в рантайме", () => {
    process.env.JARVIS_DATA_DIR = "D:/first";
    const p = lazyDataPath("memory");
    expect(p()).toBe(join("D:/first", "memory"));
    process.env.JARVIS_DATA_DIR = "D:/second"; // смена env уже после первого обращения
    expect(p()).toBe(join("D:/first", "memory")); // тот же путь — стор не переезжает на ходу
  });

  it("resetLazyPathsForTests сбрасывает кеш (изоляция тестов между файлами)", () => {
    process.env.JARVIS_DATA_DIR = "D:/one";
    const p = lazyDataPath("voices.json");
    expect(p()).toBe(join("D:/one", "voices.json"));
    process.env.JARVIS_DATA_DIR = "D:/two";
    resetLazyPathsForTests();
    expect(p()).toBe(join("D:/two", "voices.json"));
  });
});
