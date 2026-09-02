/**
 * 🔴 ПОВЕДЕНЧЕСКИЕ тесты рельсов самоправки (аудит тестов 2026-09-01).
 *
 * Прежние тесты этих гардов были ГРЕПОМ ПО ИСХОДНИКУ: `expect(body).toContain("protectedHits")`.
 * Аудит доказал их бесполезность мутацией — обезвредил ТРИ гарда сразу (`hits.length > 0` →
 * `> 999`), и все 93 теста зоны остались зелёными. То есть в самой опасной части системы —
 * там, где автономия могла бы снять себе ограничители, — проверок фактически не было.
 *
 * Здесь цикл гоняется на НАСТОЯЩЕМ git-репозитории во временном каталоге: делаем правку
 * файла-ограничителя и требуем отказа на каждом шаге, который может её пропустить дальше.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetLazyPathsForTests } from "../paths.js";
import { _resetSelfRepoRootForTest, _setSelfRepoRootForTest } from "./repo.js";
import { applySelfPatch, commitSelfPatch, loadState, repoStatus } from "./patch.js";

/** Файл-ограничитель из PROTECTED_PATHS — правку именно такого цикл обязан не пропустить. */
const GUARD_FILE = "apps/server/src/brain/consent.ts";
const ORDINARY_FILE = "apps/server/src/brain/router/index.ts";

let repo = "";
let dataDir = "";
const savedDataDir = process.env.JARVIS_DATA_DIR;

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();

function write(rel: string, body: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

/** Состояние цикла, как его оставил бы успешный verify (сам verify тут не гоняем — нет тулчейна). */
function writeState(over: Record<string, unknown> = {}): void {
  const state = {
    branch: "self/2026-09-01-проба",
    baseBranch: "main",
    title: "проба",
    startedAt: new Date().toISOString(),
    stage: "verified",
    lastVerify: { ok: true, summary: "Проверки зелёные", at: new Date().toISOString() },
    verifiedCommit: git("rev-parse", "HEAD"),
    ...over,
  };
  writeFileSync(join(dataDir, "self-patch.json"), JSON.stringify(state), "utf8");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "jarvis-rails-"));
  dataDir = mkdtempSync(join(tmpdir(), "jarvis-rails-data-"));
  process.env.JARVIS_DATA_DIR = dataDir;
  resetLazyPathsForTests();
  _setSelfRepoRootForTest(repo);

  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write(GUARD_FILE, "export const CONSENT = 1;\n");
  write(ORDINARY_FILE, "export const ROUTER = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "база");
  git("checkout", "-qb", "self/2026-09-01-проба");
});

afterEach(() => {
  _resetSelfRepoRootForTest();
  if (savedDataDir === undefined) delete process.env.JARVIS_DATA_DIR;
  else process.env.JARVIS_DATA_DIR = savedDataDir;
  resetLazyPathsForTests();
  rmSync(repo, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("рельсы самоправки — поведение, а не текст исходника", () => {
  it("правка ограничителя, ЗАКОММИЧЕННАЯ в ветке, не проходит фиксацию", async () => {
    write(GUARD_FILE, "export const CONSENT = 2; // снял гейт\n");
    git("add", "-A");
    git("commit", "-qm", "правка ограничителя");
    writeState({ verifiedCommit: git("rev-parse", "HEAD") });

    const r = await commitSelfPatch("безобидное имя");

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/ограничител/i);
    expect(r.message).toContain(GUARD_FILE);
  });

  it("та же правка не проходит и ПРИМЕНЕНИЕ (второй рубеж, если первый обошли)", async () => {
    write(GUARD_FILE, "export const CONSENT = 3;\n");
    git("add", "-A");
    git("commit", "-qm", "правка ограничителя");
    writeState({ stage: "committed", verifiedCommit: git("rev-parse", "HEAD") });

    const r = await applySelfPatch();

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/ограничител/i);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("self/2026-09-01-проба"); // на main не ушли
  });

  it("обычная правка проходит фиксацию — рельсы не парализуют работу", async () => {
    write(ORDINARY_FILE, "export const ROUTER = 2;\n");
    git("add", "-A");
    git("commit", "-qm", "обычная правка");
    writeState({ verifiedCommit: git("rev-parse", "HEAD") });

    const r = await commitSelfPatch("ускорил роутер");

    expect(r.ok).toBe(true);
    expect((await loadState())?.stage).toBe("committed");
  });

  it("НЕзакоммиченная правка ограничителя тоже видна (рабочее дерево, не только коммиты)", async () => {
    write(ORDINARY_FILE, "export const ROUTER = 3;\n");
    git("add", "-A");
    git("commit", "-qm", "обычная правка");
    writeState({ verifiedCommit: git("rev-parse", "HEAD") });
    write(GUARD_FILE, "export const CONSENT = 4; // дописано ПОСЛЕ проверки\n");

    const r = await commitSelfPatch("вроде обычная правка");

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/изменил|ограничител/i); // либо «код изменился», либо прямо про рельсы
  });

  it("применение непроверенного не проходит: HEAD разошёлся с проверенным коммитом", async () => {
    write(ORDINARY_FILE, "export const ROUTER = 4;\n");
    git("add", "-A");
    git("commit", "-qm", "проверенная правка");
    const verified = git("rev-parse", "HEAD");
    write(ORDINARY_FILE, "export const ROUTER = 5; // дописано после проверки\n");
    git("add", "-A");
    git("commit", "-qm", "дописано после проверки");
    writeState({ stage: "committed", verifiedCommit: verified });

    const r = await applySelfPatch();

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/отличается от проверенного/i);
  });

  it("применение без отметки о проверке не проходит вовсе", async () => {
    write(ORDINARY_FILE, "export const ROUTER = 6;\n");
    git("add", "-A");
    git("commit", "-qm", "правка");
    writeState({ stage: "committed", verifiedCommit: undefined });

    const r = await applySelfPatch();

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/нет отметки о пройденной проверке/i);
  });

  it("грязное дерево не уезжает на рабочую ветку вместе с применением", async () => {
    write(ORDINARY_FILE, "export const ROUTER = 7;\n");
    git("add", "-A");
    git("commit", "-qm", "правка");
    writeState({ stage: "committed", verifiedCommit: git("rev-parse", "HEAD") });
    write(ORDINARY_FILE, "export const ROUTER = 8; // незакоммичено\n");

    const r = await applySelfPatch();

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/незафиксированные/i);
    expect((await repoStatus()).branch).toBe("self/2026-09-01-проба");
  });
});
