/**
 * Общее для живых тестов браузерной лаборатории: пропуск с ПРИЧИНОЙ, если нет Chromium (или LAB_SKIP_LIVE=1), и мелкие
 * помощники проверки по факту. Тест без браузера не «зелёный»: причина видна в имени набора.
 */
import { describe } from "vitest";
import type { BenchToolReply } from "./bench-client.js";
import type { BrowserLab } from "./browser-lab.js";
import { describeProbe, probeChromium } from "./find-chromium.js";

const probe = probeChromium();

/** Причина пропуска или null. */
export const skipReason: string | null =
  process.env.LAB_SKIP_LIVE === "1" ? "LAB_SKIP_LIVE=1" : probe.found ? null : describeProbe(probe);

/** describe живого набора: без браузера пропускается, причина — в имени набора. */
export function liveSuite(name: string, fn: () => void): void {
  describe.skipIf(skipReason !== null)(skipReason !== null ? `${name} [ПРОПУСК: ${skipReason}]` : name, fn);
}

/** Запросы страниц к фикстурам без шума браузера (favicon, общий скрипт журнала). */
export const pageHits = (lab: BrowserLab): Array<{ path: string; host: string; status: number }> =>
  lab.fixtures.hits().filter((h) => h.path !== "/favicon.ico" && h.path !== "/__lab.js");

/** browser_open + browser_inspect: снимок с ref-ами для `$ref:<подпись>`. */
export async function openAndInspect(lab: BrowserLab, path: string, host?: string): Promise<BenchToolReply> {
  const opened = await lab.tool("browser_open", { url: lab.url(path, host) });
  if (opened.result.isError) throw new Error(`browser_open ${path}: ${opened.result.text}`);
  return lab.tool("browser_inspect", {});
}

export interface SnapshotElement {
  name: string;
  ref: string;
  role?: string;
  frameId?: number;
  secret?: boolean;
  state?: Record<string, unknown>;
}

/** Элементы из ответа browser_inspect (JSON внутри untrusted-обёртки). */
export function snapshotElements(r: BenchToolReply): SnapshotElement[] {
  const body = /<untrusted_content[^>]*>\n([^]*?)\n<\/untrusted_content>/u.exec(r.result.text)?.[1] ?? "{}";
  return (JSON.parse(body) as { elements?: SnapshotElement[] }).elements ?? [];
}
