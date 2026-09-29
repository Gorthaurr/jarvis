import { describe, expect, it } from "vitest";
import { parseFnLengths, parseNodeTest, parseTsc, parseVitestJson, relPath } from "./parse.js";

const ROOT = "C:/repo";
const vitestJson = JSON.stringify({
  testResults: [
    {
      name: "C:\\repo\\apps\\server\\src\\a.test.ts",
      status: "passed",
      assertionResults: [
        { status: "passed", fullName: "a ok" },
        { status: "skipped", fullName: "a skipped" },
        { status: "pending", fullName: "a pending" },
        { status: "todo", fullName: "a todo" },
        { status: "failed", fullName: "a fails" },
      ],
    },
    { name: "C:\\repo\\apps\\server\\src\\broken.test.ts", status: "failed", assertionResults: [] },
  ],
});

describe("parseVitestJson", () => {
  const p = parseVitestJson(vitestJson, ROOT);

  it("считает passed/failed/skipped/todo сам, pending = пропуск", () => {
    expect(p?.tests).toEqual({ total: 5, passed: 1, failed: 1, skipped: 2, todo: 1 });
  });

  it("пропущенные — с относительным путём и именем", () => {
    expect(p?.skipped).toEqual([
      { file: "apps/server/src/a.test.ts", name: "a skipped" },
      { file: "apps/server/src/a.test.ts", name: "a pending" },
    ]);
  });

  it("файл, упавший целиком (без единого assertion), виден отдельно и как failed-исход", () => {
    expect(p?.failedSuites).toEqual(["apps/server/src/broken.test.ts"]);
    expect(p?.outcomes.get("apps/server/src/broken.test.ts > <файл>")).toBe("failed");
  });

  it("исходы для флейк-скана: passed/failed/skipped", () => {
    expect(p?.outcomes.get("apps/server/src/a.test.ts > a ok")).toBe("passed");
    expect(p?.outcomes.get("apps/server/src/a.test.ts > a fails")).toBe("failed");
    expect(p?.outcomes.get("apps/server/src/a.test.ts > a pending")).toBe("skipped");
  });

  it("мусор вместо JSON → null (шаг упадёт, а не позеленеет)", () => {
    expect(parseVitestJson("not json at all", ROOT)).toBeNull();
    expect(parseVitestJson("", ROOT)).toBeNull();
  });
});

describe("relPath", () => {
  it("режет корень и нормализует слэши; чужой путь оставляет", () => {
    expect(relPath("C:/repo/", "C:\\repo\\x\\y.ts")).toBe("x/y.ts");
    expect(relPath("C:/repo", "D:\\other\\y.ts")).toBe("D:/other/y.ts");
  });
});

describe("parseNodeTest", () => {
  it("TAP: # tests/pass/fail/skipped", () => {
    expect(parseNodeTest("1..5\n# tests 5\n# suites 0\n# pass 4\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n")).toEqual({ total: 5, passed: 4, failed: 1, skipped: 0, todo: 0 });
  });

  it("spec: ℹ tests/pass, cancelled считается падением", () => {
    expect(parseNodeTest("ℹ tests 3\nℹ pass 2\nℹ fail 0\nℹ cancelled 1\nℹ skipped 0\n")).toEqual({ total: 3, passed: 2, failed: 1, skipped: 0, todo: 0 });
  });

  it("нет строк итога → null (не считаем зелёным)", () => {
    expect(parseNodeTest("Error: cannot find module")).toBeNull();
  });
});

describe("parseTsc / parseFnLengths", () => {
  it("tsc: берёт только строки error TSxxxx", () => {
    const out = "src/a.ts(1,2): error TS2322: Type 'x' is not assignable\n  detail line\nsrc/b.ts(3,4): error TS7006: implicit any\n";
    expect(parseTsc(out)).toHaveLength(2);
    expect(parseTsc("")).toEqual([]);
  });

  it("fn-lengths: строки функций; вывод без итоговой шапки → null", () => {
    const out = "функций: 2263, длиннее 150 строк: 2\n  589  src/gateway/server.ts:121-709  createGateway\n  157  src/brain/agent/index.ts:50-206  handleUserText\n";
    expect(parseFnLengths(out)).toEqual([
      { lines: 589, file: "src/gateway/server.ts", name: "createGateway" },
      { lines: 157, file: "src/brain/agent/index.ts", name: "handleUserText" },
    ]);
    expect(parseFnLengths("Error: ENOENT")).toBeNull();
  });
});
