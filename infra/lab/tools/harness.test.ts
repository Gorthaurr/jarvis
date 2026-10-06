/**
 * Механика харнесса на СОБСТВЕННОМ мини-«ПК» (не зависит от того, насколько наполнен FakeDesktop соседей):
 * проверяем именно мост, политику §14, изоляцию и честность «не проверяется».
 */
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionCommand, ActionResult } from "../../../packages/protocol/src/index.js";
import { LAB_TMP_ROOT } from "./isolation.js";
import { type ToolLab, createToolLab } from "./harness.js";
import { miniDesktop, okResult } from "./mini-desktop.js";

const ok = okResult;

let lab: ToolLab | undefined;
afterEach(async () => {
  await lab?.close();
  lab = undefined;
});

describe("createToolLab: §14 и честность исхода", () => {
  it("fs_delete при отказе владельца: declined, вопрос задан, команда клиенту НЕ ушла", async () => {
    lab = createToolLab({ desktop: miniDesktop((_c, m) => ok(m.commandId)), confirm: "no" });
    const r = await lab.call("fs_delete", { path: "C:/Users/lab/a.txt" });
    expect(r.flags.declined).toBe(true);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toMatchObject({ kind: "irreversible", answer: "no", outcome: "denied" });
    expect(r.actions).toHaveLength(0);
  });

  it("fs_delete при «да»: команда fs.delete ушла клиенту с JSON-копией аргументов и ответ вернулся", async () => {
    const seen: ActionCommand[] = [];
    lab = createToolLab({ desktop: miniDesktop((c, m) => (seen.push(c), ok(m.commandId, "удалено"))), confirm: "yes" });
    const r = await lab.call("fs_delete", { path: "C:/Users/lab/a.txt" });
    expect(r.isError).toBe(false);
    expect(r.flags.declined).toBeUndefined();
    expect(r.actions.map((a) => a.cmd.kind)).toEqual(["fs.delete"]);
    expect(seen[0]).toMatchObject({ kind: "fs.delete", path: "C:/Users/lab/a.txt" });
    expect(r.actions[0]!.result.ok).toBe(true);
  });

  it("политика-массив расходуется по порядку; кончилась — отказ с пометкой overflow", async () => {
    lab = createToolLab({ desktop: miniDesktop((_c, m) => ok(m.commandId)) });
    const r = await lab.call("system_power", { op: "shutdown" }, { confirm: ["undelivered"] });
    expect(r.asked[0]).toMatchObject({ answer: "undelivered", outcome: "undelivered" });
    expect(r.flags.declined).toBe(true);
    expect(r.text).toMatch(/не смог спросить|недоступн/i); // «не спросили» ≠ «владелец отказал»
    const r2 = await lab.call("fs_delete", { path: "C:/x" }, { confirm: [] });
    expect(r2.asked[0]).toMatchObject({ answer: "no", overflow: true });
  });

  it("функция-политика получает сводку, вид и номер вопроса", async () => {
    const calls: Array<[string, string, number]> = [];
    lab = createToolLab({ desktop: miniDesktop((_c, m) => ok(m.commandId)) });
    await lab.call("fs_delete", { path: "C:/x" }, { confirm: (s, k, n) => (calls.push([s, k, n]), "no") });
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toBe("irreversible");
    expect(calls[0]![2]).toBe(1);
  });
});

describe("createToolLab: мост к FakeDesktop", () => {
  it("чужой commandId в ответе — честная ошибка runtime (на проводе результат потерялся бы)", async () => {
    lab = createToolLab({ desktop: miniDesktop(() => ok("не-тот-id")) });
    const r = await lab.call("fs_read", { path: "C:/Users/lab/a.txt" });
    expect(r.isError).toBe(true);
    expect(r.actions[0]!.result.error?.code).toBe("runtime");
    expect(r.actions[0]!.result.error?.message).toMatch(/commandId/);
  });

  it("зависший обработчик даёт timeout, а не подвешивает вызов", async () => {
    lab = createToolLab({ desktop: miniDesktop(() => new Promise<ActionResult>(() => {})), actionTimeoutMs: 40 });
    const r = await lab.call("fs_read", { path: "C:/x" });
    expect(r.actions[0]!.result.error?.code).toBe("timeout");
    expect(r.isError).toBe(true);
  });

  it("результат, который не пройдёт по проводу (BigInt), — runtime, не молчаливый успех", async () => {
    lab = createToolLab({ desktop: miniDesktop((_c, m) => ok(m.commandId, { big: BigInt(10) })) });
    const r = await lab.call("fs_read", { path: "C:/x" });
    expect(r.actions[0]!.result.error?.code).toBe("runtime");
  });

  it("команда уходит обработчику JSON-копией: undefined-поля пропадают, правка копии не течёт в исходник", async () => {
    let seen: Record<string, unknown> | undefined;
    lab = createToolLab({
      desktop: miniDesktop((c, m) => {
        seen = c as unknown as Record<string, unknown>;
        seen.path = "испорчено";
        return ok(m.commandId);
      }),
    });
    const cmd = { kind: "fs.read", path: "C:/a", maxBytes: undefined } as unknown as ActionCommand;
    await lab.ctx.session.sendAction(cmd);
    expect(seen && "maxBytes" in seen).toBe(false); // на проводе undefined не существует
    expect((cmd as unknown as { path: string }).path).toBe("C:/a");
  });

  it("фасад look{what:windows} уходит клиенту как window.list", async () => {
    lab = createToolLab({ desktop: miniDesktop((_c, m) => ok(m.commandId, { windows: [] })) });
    const r = await lab.call("look", { what: "windows" });
    expect(r.actions.map((a) => a.cmd.kind)).toEqual(["window.list"]);
  });

  it("записи действий и вопросы сбрасываются между вызовами", async () => {
    lab = createToolLab({ desktop: miniDesktop((_c, m) => ok(m.commandId)) });
    await lab.call("fs_read", { path: "C:/a" });
    const second = await lab.call("look", { what: "windows" });
    expect(second.actions).toHaveLength(1);
  });
});

describe("createToolLab: «не проверяется в лаборатории»", () => {
  it("browser_read без расширения не диспетчеризуется, причина названа", async () => {
    let touched = 0;
    lab = createToolLab({ desktop: miniDesktop((_c, m) => (touched++, ok(m.commandId))) });
    const r = await lab.call("browser_read", {});
    expect(r.notVerifiable).toMatch(/расширени/);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^не проверяется в лаборатории/);
    expect(touched).toBe(0);
  });

  it("с переданным ext лимит снимается и хендлер реально вызывается", async () => {
    const ext = { connected: true, tabList: async () => ({ tabs: [{ tabId: 1, url: "https://example.com/", host: "example.com", title: "Пример" }] }) };
    lab = createToolLab({ ctx: { ext: ext as never } });
    const r = await lab.call("browser_tabs", {});
    expect(r.notVerifiable).toBeUndefined();
    expect(r.text).toContain("example.com");
  });

  it("self_patch запрещён безусловно (правит репозиторий), ctx его не разблокирует", async () => {
    lab = createToolLab({ ctx: { productMode: false } });
    const r = await lab.call("self_patch", { goal: "x" });
    expect(r.notVerifiable).toMatch(/РЕПОЗИТОРИЯ/);
  });
});

describe("createToolLab: изоляция данных и сервисы", () => {
  it("данные прогона — в %TEMP%/jarvis-lab, напоминание пишется туда и живёт в сервисе", async () => {
    lab = createToolLab({ desktop: miniDesktop((_c, m) => ok(m.commandId)) });
    expect(process.env.JARVIS_DATA_DIR).toBe(lab.dataDir);
    expect(lab.dataDir.startsWith(`${LAB_TMP_ROOT}/`)).toBe(true);
    const r = await lab.call("set_reminder", { text: "Позвонить маме", delay_seconds: 3600 });
    expect(r.isError).toBe(false);
    const l = await lab.call("list_reminders", {});
    expect(l.text).toContain("Позвонить маме");
    await new Promise((res) => setTimeout(res, 150)); // запись стора асинхронна
    const file = `${lab.dataDir}/reminders.json`;
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("Позвонить маме");
  });

  it("после close env возвращается в каталог-сторож внутри %TEMP%, а не в дефолт владельца", async () => {
    const l = createToolLab();
    const dir = l.dir;
    await l.close();
    expect(process.env.JARVIS_DATA_DIR?.startsWith(`${LAB_TMP_ROOT}/`)).toBe(true);
    expect(process.env.JARVIS_DATA_DIR).not.toBe(`${dir}/data`);
    expect(existsSync(dir)).toBe(false);
  });

  it("web_search/web_fetch берут страницы из seed.web, оффлайн виден как отказ", async () => {
    lab = createToolLab({ seed: { web: { "https://example.com/rates": "<html><title>Курс</title><body>доллар стоит девяносто рублей</body></html>" } } });
    const s = await lab.call("web_search", { query: "доллар курс" });
    expect(s.text).toContain("https://example.com/rates");
    const f = await lab.call("web_fetch", { url: "https://example.com/rates" });
    expect(f.text).toContain("девяносто");
    const missing = await lab.call("web_fetch", { url: "https://example.com/none" });
    expect(missing.isError).toBe(true);
  });

  it("память memory_write → memory_search работает на изолированном эпизодике (dev-пропуск выключен)", async () => {
    lab = createToolLab();
    const w = await lab.call("memory_write", { text: "Любимый цвет владельца — зелёный", kind: "preference" });
    expect(w.text).not.toMatch(/Dev-сессия/);
    const s = await lab.call("memory_search", { query: "любимый цвет" });
    expect(s.text).toContain("зелёный");
  });
});
