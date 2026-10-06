/**
 * Глаза агента в браузере лаборатории по CDP-трубе: какие вкладки открыты, что в DOM страницы, снимок экрана.
 * Это ПРЯМОЕ наблюдение (мимо расширения и мимо Джарвиса) — по нему проверяют, что инструмент сделал то, что сказал.
 */
import type { CdpPipe } from "./cdp-pipe.js";

export interface PageInfo {
  targetId: string;
  url: string;
  title: string;
}

export async function pages(cdp: CdpPipe): Promise<PageInfo[]> {
  const t = await cdp.send("Target.getTargets");
  return ((t.result?.targetInfos ?? []) as Array<{ targetId: string; type: string; url: string; title: string }>)
    .filter((x) => x.type === "page")
    .map((x) => ({ targetId: x.targetId, url: x.url, title: x.title }));
}

/** Сессия отладки вкладки; отсоединяем после вызова, чтобы не копить сессии. */
async function withPage<T>(cdp: CdpPipe, urlPart: string | undefined, fn: (session: string) => Promise<T>): Promise<T> {
  const target = (await pages(cdp)).find((p) => (urlPart ? p.url.includes(urlPart) : p.url !== "about:blank"));
  if (!target) throw new Error(`вкладка${urlPart ? ` с «${urlPart}»` : ""} не найдена: открытые — ${(await pages(cdp)).map((p) => p.url).join(", ") || "нет"}`);
  const att = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const session = att.result?.sessionId as string | undefined;
  if (!session) throw new Error(`не подключился к вкладке: ${att.error?.message ?? "нет sessionId"}`);
  try {
    return await fn(session);
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId: session }).catch(() => undefined);
  }
}

/** Выражение в СТРАНИЦЕ (по фрагменту url; без него — первая не пустая вкладка). */
export function evalInPage(cdp: CdpPipe, expression: string, urlPart?: string): Promise<unknown> {
  return withPage(cdp, urlPart, async (session) => {
    const m = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
    if (m.error) throw new Error(m.error.message);
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text);
    return m.result?.result?.value;
  });
}

/** PNG вкладки. */
export function screenshotPage(cdp: CdpPipe, urlPart?: string): Promise<Buffer> {
  return withPage(cdp, urlPart, async (session) => {
    const m = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
    if (!m.result?.data) throw new Error(`снимок не получен: ${m.error?.message ?? "пусто"}`);
    return Buffer.from(m.result.data as string, "base64");
  });
}
