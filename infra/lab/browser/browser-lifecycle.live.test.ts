/**
 * ЖИВОЕ: жизненный цикл и честность отказов. (1) Страница повисла — клик без ответа честно «неизвестно» (uncertain), хотя
 * страница его получила. (2) Chrome умер — инструменты говорят «не подключено», а не выдают успех. (3) close() гасит
 * ТОЛЬКО своё: наши процессы и каталоги исчезли, Chrome владельца жив. (4) Родитель умер без close() — браузер не остаётся.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { repoRoot } from "../lib/deps.js";
import { removeRunDir } from "../lib/server-dir.js";
import { isPidAlive, sleep } from "../lib/server-proc.js";
import { labRoot } from "../lib/server-state.js";
import { type BrowserLab, startBrowserLab } from "./browser-lab.js";
import { chromeProcs } from "./proc-list.js";
import { liveSuite } from "./test-support.js";

/** Главный процесс Chrome владельца: без --type (не дочерний) и без --user-data-dir (профиль по умолчанию). Дочерние renderer-ы приходят и уходят сами. */
const isOwnerMain = (cmd: string): boolean => !/--type=/u.test(cmd) && !/--user-data-dir=/u.test(cmd);

/** Запустить exit-child и вернуть его вывод (pid браузера, каталоги) после смерти самого дочернего процесса. */
function runChild(mode: "exit" | "throw"): Promise<{ pid: number; dir: string; extDir: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", "tsx", "infra/lab/browser/exit-child.ts", mode], { cwd: repoRoot("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => (err += d));
    p.once("exit", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n")[0] ?? "") as { pid: number; dir: string; extDir: string });
      } catch {
        reject(new Error(`дочерний процесс не напечатал pid: ${out}\n${err.slice(-1500)}`));
      }
    });
  });
}

liveSuite("браузерная лаборатория: жизненный цикл и честность отказов", () => {
  let lab: BrowserLab;
  let ownerBefore: number[] = [];

  beforeAll(async () => {
    ownerBefore = (await chromeProcs()).filter((p) => isOwnerMain(p.cmd)).map((p) => p.pid);
    lab = await startBrowserLab();
  }, 120_000);
  afterAll(async () => void (await lab?.close()), 60_000);

  it("наши процессы Chrome различимы по каталогу профиля (иначе проверка «сирот нет» была бы пустой)", async () => {
    const mine = (await chromeProcs()).filter((p) => p.cmd.includes(`chrome-${lab.server.id}`));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.map((p) => p.pid)).toContain(lab.browser.pid);
    expect(ownerBefore).not.toContain(lab.browser.pid);
  });

  it("страница повисла: клик без ответа = «НЕ ЗНАЮ» (uncertain, ошибка), а страница клик ПОЛУЧИЛА", async () => {
    await lab.tool("browser_open", { url: lab.url("/hang") });
    await lab.tool("browser_inspect", {});
    const r = await lab.tool("browser_act", { intent: "click", ref: "$ref:Зависнуть" });
    expect(r.result.isError).toBe(true);
    expect(r.result.flags.uncertain).toBe(true);
    expect(r.result.text).toContain("НЕ ЗНАЮ, сработало ли");
    expect(r.result.text).toContain("НЕ повторяй вслепую");
    expect(lab.fixtures.events("hang_started")).toHaveLength(1); // клик дошёл: «неизвестно» — не «не вышло»
    expect(r.ms).toBeGreaterThanOrEqual(19_000);
  }, 60_000);

  it("Chrome умер: инструменты честно говорят «не подключено», клиентская команда отклонена, успеха нет", async () => {
    await lab.browser.close();
    for (let i = 0; i < 50 && (await lab.state()).ext.connected; i += 1) await sleep(100);
    const read = await lab.tool("browser_read", {});
    expect(read.result.isError).toBe(true);
    expect(read.result.text).toContain("не подключено");
    const open = await lab.tool("browser_open", { url: lab.url("/") });
    expect(open.result.isError).toBe(true);
    expect(open.clientActions.map((a) => a.kind)).toEqual(["browser.open"]); // откат на клиента ПК, а клиента нет
    expect(open.result.text).toContain("НЕ исполнено");
  }, 60_000);

  it("close() гасит только своё: наших процессов и каталогов нет, Chrome владельца жив", async () => {
    const browserPid = lab.browser.pid;
    const serverPid = lab.server.pid;
    await lab.close();
    expect(isPidAlive(browserPid)).toBe(false);
    expect(isPidAlive(serverPid)).toBe(false);
    expect(existsSync(lab.ext.dir)).toBe(false);
    expect(existsSync(lab.server.dir)).toBe(false);
    expect(existsSync(`${labRoot()}/chrome-${lab.server.id}`)).toBe(false);
    expect((await chromeProcs()).filter((p) => p.cmd.includes(`chrome-${lab.server.id}`))).toEqual([]);
    for (const pid of ownerBefore) expect(isPidAlive(pid), `главный процесс чужого Chrome ${pid} должен жить`).toBe(true);
  }, 60_000);

  it.each(["exit", "throw"] as const)("родитель умер без close() (%s): браузер не остаётся сиротой", async (mode) => {
    const child = await runChild(mode);
    let alive = true;
    for (let i = 0; i < 100 && alive; i += 1) {
      alive = isPidAlive(child.pid);
      if (alive) await sleep(100);
    }
    await removeRunDir(child.dir);
    await removeRunDir(child.extDir);
    expect(alive).toBe(false);
  }, 60_000);
});
