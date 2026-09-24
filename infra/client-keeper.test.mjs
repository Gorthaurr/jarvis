// node --test infra/client-keeper.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { exitDecision, parseElectronPaths } from "./client-keeper.mjs";

test("падение (ненулевой код) → перезапуск", () => {
  assert.equal(exitDecision({ code: 2147483651, signal: null, uptimeMs: 4000, otherAlive: false, ownerQuitMarked: false }), "restart");
});
test("«Выйти» из трея (маркер) → не перезапускаем, даже с ненулевым кодом", () => {
  assert.equal(exitDecision({ code: 1, signal: null, uptimeMs: 60_000, otherAlive: false, ownerQuitMarked: true }), "owner-quit");
});
test("код 0 после долгой работы → штатный выход, не воюем", () => {
  assert.equal(exitDecision({ code: 0, signal: null, uptimeMs: 60_000, otherAlive: false, ownerQuitMarked: false }), "owner-quit");
});
test("проиграли single-instance лок ручному экземпляру → наблюдение", () => {
  assert.equal(exitDecision({ code: 0, signal: null, uptimeMs: 800, otherAlive: true, ownerQuitMarked: false }), "watch");
});
test("wmic csv разбирается, путь с запятой не ломает pid", () => {
  const csv = "\r\nNode,ExecutablePath,ProcessId\r\nPC,C:\a,b\electron.exe,123\r\nPC,,456\r\n";
  assert.deepEqual(parseElectronPaths(csv), [{ path: "C:\a,b\electron.exe", pid: 123 }]);
});
