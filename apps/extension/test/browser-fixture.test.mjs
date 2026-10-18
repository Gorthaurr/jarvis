import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { withBrowserFixture } from "./browser-fixture.mjs";
import { launchBrowserPage } from "./page-browser.mjs";
import { launchExtension } from "./ext-harness.mjs";

test("startup failure removes the directory before returning the error", async () => {
  let directory;
  await assert.rejects(withBrowserFixture("jarvis-ext-cleanup-", async (fixture) => {
    directory = fixture.dir;
    writeFileSync(join(directory, "partial-build"), "fixture");
    throw new Error("deliberate build failure");
  }), /deliberate build failure/u);
  assert.equal(existsSync(directory), false);
});

test("close waits for the owned process and removes its profile, including repeated close", async () => {
  const fixture = await withBrowserFixture("jarvis-ext-cleanup-", async (owned) => owned);
  try {
    const proc = fixture.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    await once(proc, "spawn");
    await Promise.all([fixture.close(), fixture.close()]);
    assert.ok(proc.exitCode !== null || proc.signalCode !== null);
    assert.equal(existsSync(fixture.dir), false);
  } finally { await fixture.close(); }
});

test("page launcher cleans up when the executable exits before opening the debug port", async () => {
  const parent = await withBrowserFixture("jarvis-ext-cleanup-", async (owned) => owned);
  const prior = Object.fromEntries(["TMP", "TEMP", "TMPDIR"].map((key) => [key, process.env[key]]));
  try {
    for (const key of Object.keys(prior)) process.env[key] = parent.dir;
    // Node rejects Chrome's flags: a real failed child process, without launching the user's browser.
    await assert.rejects(launchBrowserPage(process.execPath), /Chrome exited before the fixture was ready/u);
    assert.deepEqual(readdirSync(parent.dir), []);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await parent.close();
  }
});

test("close accepts a process exiting when its transport closes", async () => {
  const fixture = await withBrowserFixture("jarvis-ext-cleanup-", async (owned) => owned);
  try {
    const proc = fixture.spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"],
      { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    await once(proc, "spawn");
    fixture.onClose(() => proc.stdin.end());
    await fixture.close();
    assert.ok(proc.exitCode !== null || proc.signalCode !== null);
    assert.equal(existsSync(fixture.dir), false);
  } finally { await fixture.close(); }
});

test("extension launcher cleans up its built copy and closed CDP pipe after browser startup fails", async () => {
  const parent = await withBrowserFixture("jarvis-ext-cleanup-", async (owned) => owned);
  const keys = ["TMP", "TEMP", "TMPDIR", "CHROME_PATH"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = key === "CHROME_PATH" ? process.execPath : parent.dir;
    await assert.rejects(launchExtension(), /Chrome exited before the fixture was ready/u);
    assert.deepEqual(readdirSync(parent.dir), []);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await parent.close();
  }
});
