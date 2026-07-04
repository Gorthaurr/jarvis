import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runnerEnv } from "./code-runner.js";

// § L8: denylist по ИМЕНИ не ловит секрет в ЗНАЧЕНИИ безобидной переменной (DATABASE_URL с кредами
// в URL) — runnerEnv должен дополнительно резать по ЗНАЧЕНИЮ (URL-with-creds паттерн).
describe("code-runner — runnerEnv фильтрует секреты", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  });

  it("вырезает переменные с секретным ИМЕНЕМ (старое поведение не сломано)", () => {
    process.env.API_KEY = "sk-123";
    process.env.MY_SECRET = "x";
    process.env.AUTH_TOKEN = "y";
    process.env.PATH = "C:/Windows/System32";
    const out = runnerEnv();
    expect(out.API_KEY).toBeUndefined();
    expect(out.MY_SECRET).toBeUndefined();
    expect(out.AUTH_TOKEN).toBeUndefined();
    expect(out.PATH).toBe("C:/Windows/System32");
  });

  it("вырезает безобидное ИМЯ с кредами в URL-ЗНАЧЕНИИ (DATABASE_URL=postgres://user:pass@host)", () => {
    process.env.DATABASE_URL = "postgres://user:S3cr3t@localhost:5432/db";
    process.env.USERPROFILE = "C:/Users/anton";
    const out = runnerEnv();
    expect(out.DATABASE_URL).toBeUndefined();
    expect(out.USERPROFILE).toBe("C:/Users/anton");
  });

  it("не трогает обычные URL без креды (нет ложных срабатываний)", () => {
    process.env.SOME_URL = "https://example.com/path?x=1";
    const out = runnerEnv();
    expect(out.SOME_URL).toBe("https://example.com/path?x=1");
  });
});
