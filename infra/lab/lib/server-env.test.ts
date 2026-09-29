import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { attachLabServer, startLabServer } from "./server.js";
import { MARKER, assertPlainPath, assertSafeDir, removeRunDir } from "./server-dir.js";
import { planServerEnv, renderEnvFile } from "./server-env.js";
import { claimPort, isPortFree, releasePort } from "./server-proc.js";

const fwd = (p: string): string => p.split("\\").join("/");
const base = { port: 8830, dataDir: "C:/x/data", pgdata: "C:/x/pg", devToken: "tok", readOwner: () => undefined };
const parent = { PATH: "p", SystemRoot: "C:\\Windows", ANTHROPIC_API_KEY: "sk-parent", CLAUDE_CODE_OAUTH_TOKEN: "oauth-parent", HTTPS_PROXY: "http://proxy", DEEPGRAM_API_KEY: "dg-parent" };

describe("окружение лаб-сервера", () => {
  it("brain off: подписка и API выключены, порт/данные/БД лабораторные (файл перебивает боевой .env)", () => {
    const { file, proc } = planServerEnv({ ...base, parentEnv: parent });
    expect(file).toMatchObject({
      PORT: "8830", HOST: "127.0.0.1", JARVIS_DEV_HTTP: "1", JARVIS_DEV_TOKEN: "tok", DATABASE_URL: "pglite://C:/x/pg",
      JARVIS_DATA_DIR: "C:/x/data", STT_PROVIDER: "mock", JARVIS_SUBSCRIPTION_FALLBACK: "0", ANTHROPIC_API_KEY: "", JARVIS_PRIMARY_LLM: "0",
    });
    expect(proc.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(file.CLAUDE_CODE_OAUTH_TOKEN).toBe(""); // пустое значение в файле перебивает унаследованное
  });

  it("окружение процесса — белый список: ни прокси, ни ключей родителя", () => {
    const { proc } = planServerEnv({ ...base, parentEnv: parent });
    expect(proc.PATH).toBe("p");
    expect(proc.SystemRoot).toBe("C:\\Windows");
    for (const k of ["HTTPS_PROXY", "ANTHROPIC_API_KEY", "DEEPGRAM_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) expect(proc[k]).toBeUndefined();
  });

  it("brain real: токен подписки только в env процесса, в файле его нет; резерв на подписку не выключается", () => {
    const { file, proc } = planServerEnv({ ...base, brain: "real", parentEnv: parent, readOwner: (n) => (n === "CLAUDE_CODE_OAUTH_TOKEN" ? "oauth-owner" : undefined) });
    expect(proc.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-owner");
    expect(renderEnvFile(file)).not.toContain("oauth-owner");
    expect(file.JARVIS_SUBSCRIPTION_FALLBACK).toBeUndefined();
  });

  it("stt deepgram: ключ только в env процесса; нет ключа - честная ошибка, не тихий mock", () => {
    const ok = planServerEnv({ ...base, stt: "deepgram", parentEnv: parent, readOwner: (n) => (n === "DEEPGRAM_API_KEY" ? "dg-owner" : undefined) });
    expect(ok.proc.DEEPGRAM_API_KEY).toBe("dg-owner");
    expect(ok.file.STT_PROVIDER).toBe("deepgram");
    expect(renderEnvFile(ok.file)).not.toContain("dg-owner");
    expect(() => planServerEnv({ ...base, stt: "deepgram", parentEnv: {} })).toThrow(/DEEPGRAM_API_KEY/u);
  });

  it("opts.env идёт в процесс и вытесняет ключ из файла (иначе dotenv override перебил бы)", () => {
    const { file, proc } = planServerEnv({ ...base, parentEnv: parent, env: { STT_PROVIDER: "whisper", X: "1" } });
    expect(proc.STT_PROVIDER).toBe("whisper");
    expect(file.STT_PROVIDER).toBeUndefined();
    expect(proc.X).toBe("1");
  });

  it("безопасные значения владельца (HF_ENDPOINT) попадают в файл", () => {
    const { file } = planServerEnv({ ...base, parentEnv: parent, readOwner: (n) => (n === "HF_ENDPOINT" ? "https://hf.example" : undefined) });
    expect(file.HF_ENDPOINT).toBe("https://hf.example");
  });
});

describe("порты", () => {
  it("8787 (боевой) запрещён как явный порт", async () => {
    await expect(claimPort(8787)).rejects.toThrow(/БОЕВОЙ/u);
  });

  it("автовыбор в 8811..8899, порты разные при параллельных вызовах, выданный повторно не отдаётся", async () => {
    const got = await Promise.all(Array.from({ length: 6 }, () => claimPort()));
    try {
      expect(new Set(got).size).toBe(6);
      for (const p of got) {
        expect(p).toBeGreaterThanOrEqual(8811);
        expect(p).toBeLessThanOrEqual(8899);
      }
      await expect(claimPort(got[0])).rejects.toThrow(/занят/u);
    } finally {
      for (const p of got) releasePort(p);
    }
  });

  it("автовыбор никогда не отдаёт 8787 и обходит avoid (единственный доступный порт - 8850)", async () => {
    const all = Array.from({ length: 89 }, (_, i) => 8811 + i);
    const port = await claimPort(undefined, all.filter((p) => p !== 8850));
    releasePort(port);
    expect(port).toBe(8850);
    // Если бы 8787 попал в диапазон перебора, единственным вариантом при avoid=всё остальное был бы он.
    await expect(claimPort(undefined, all)).rejects.toThrow(/нет свободного порта/u);
  });

  it("isPortFree видит занятый порт", async () => {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as { port: number }).port;
    expect(await isPortFree(port)).toBe(false);
    await new Promise((r) => s.close(r));
    expect(await isPortFree(port)).toBe(true);
  });
});

describe("каталог прогона", () => {
  it("внутри репозитория/данных владельца - отказ; чужой непустой каталог - отказ; свой по маркеру - ок", () => {
    expect(() => assertSafeDir("C:/Users/anton/Desktop/autokomp/jarvis/apps/server/data")).toThrow(/репозитория/u);
    expect(() => assertSafeDir("C:/Users/anton/AppData/Roaming/@jarvis/x")).toThrow(/репозитория/u);
    expect(() => assertSafeDir("C:/Users/me/AppData/Roaming/Jarvis", "C:\\Users\\me\\AppData\\Roaming")).toThrow(/репозитория/u);
    const d = fwd(mkdtempSync(`${tmpdir()}/lab-t-`));
    try {
      writeFileSync(`${d}/other.txt`, "x");
      expect(() => assertSafeDir(d)).toThrow(/не создан лабораторией/u);
      writeFileSync(`${d}/${MARKER}`, "id");
      expect(() => assertSafeDir(d)).not.toThrow();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("путь с пробелом/кириллицей/# отвергается (env-файл, PGlite, sherpa)", () => {
    for (const bad of ["C:/Мой путь/lab", "C:/a b/lab", "C:/a#b/lab"]) expect(() => assertPlainPath(bad)).toThrow(/ASCII/u);
    expect(() => assertPlainPath("C:/Users/anton/AppData/Local/Temp/jarvis-lab/lab-1")).not.toThrow();
  });

  it("removeRunDir удаляет только каталог с маркером", async () => {
    const d = fwd(mkdtempSync(`${tmpdir()}/lab-t-`));
    try {
      mkdirSync(`${d}/sub`);
      expect(await removeRunDir(d, 1, 1)).toBe(false);
      expect(existsSync(`${d}/sub`)).toBe(true);
      writeFileSync(`${d}/${MARKER}`, "id");
      expect(await removeRunDir(d, 1, 1)).toBe(true);
      expect(existsSync(d)).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("защита от чужого и от неподдержанного", () => {
  it("stop() по записи реестра НЕ убивает pid без метки --lab-id", async () => {
    const victim = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
    try {
      const h = attachLabServer({ id: "lab-fake", port: 8899, dir: "C:/nope/none", dataDir: "C:/nope/none/data", pid: victim.pid as number, devToken: "t", brain: "off", stt: "mock", clientToken: "c", startedAt: "" });
      await expect(h.stop()).rejects.toThrow(/не несёт метку/u);
      expect(h.alive()).toBe(true);
    } finally {
      victim.kill();
    }
  });

  it("brain scripted - честная ошибка, а не молчаливая подмена", async () => {
    await expect(startLabServer({ brain: "scripted" })).rejects.toThrow(/scripted не поддержан/u);
  });

  it("порт 8787 в startLabServer отвергается ДО создания каталога", async () => {
    const dir = `${fwd(tmpdir())}/jarvis-lab/never-created-8787`;
    await expect(startLabServer({ port: 8787, dir })).rejects.toThrow(/БОЕВОЙ/u);
    expect(existsSync(dir)).toBe(false);
  });
});
