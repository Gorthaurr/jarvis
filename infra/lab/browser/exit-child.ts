/**
 * Дочерний процесс для теста «браузер не переживает родителя»: поднимает браузер лаборатории и умирает БЕЗ close() —
 * `exit` (process.exit) или `throw` (необработанное исключение). Печатает одну строку JSON: pid браузера и каталоги.
 * Использование: node --import tsx infra/lab/browser/exit-child.ts exit|throw
 */
import { claimPort } from "../lib/server-proc.js";
import { labRoot } from "../lib/server-state.js";
import { launchBrowser } from "./chrome-launcher.js";
import { buildLabExtension } from "./ext-build.js";
import { findChromium } from "./find-chromium.js";

const mode = process.argv[2] === "throw" ? "throw" : "exit";
const chrome = findChromium();
if (!chrome) throw new Error("нет Chromium");
const stamp = `orphan-${Date.now().toString(36)}`;
const extDir = `${labRoot()}/ext-${stamp}`;
const dir = `${labRoot()}/chrome-${stamp}`;
// Сервера нет: расширение просто не найдёт /ext на свободном порту диапазона и будет переподключаться.
const ext = await buildLabExtension({ port: await claimPort(), dir: extDir });
const browser = await launchBrowser({ chrome, ext, dir, fixtureHosts: [], fixturePort: 1 });
process.stdout.write(`${JSON.stringify({ pid: browser.pid, dir, extDir })}\n`);
if (mode === "exit") process.exit(0);
throw new Error("лаб-тест: исключение без close()");
