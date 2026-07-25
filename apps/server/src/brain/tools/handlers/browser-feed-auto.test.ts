import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../dispatch.js";
import { browserAct, browserOpen } from "./browser.js";

/**
 * АВТОЛИСТАНИЕ ЛЕНТЫ КОРОТКИХ ВИДЕО (feed_auto, 2026-07-25 по просьбе владельца: «перемотка ютуб
 * шортсов по их окончании — он буквально ничего не делает»). Проверяем СЕРВЕРНУЮ часть контракта:
 * интент и параметры доходят до расширения, а состояние поллера (running/advanced/причина остановки)
 * честно возвращается модели — иначе она не сможет ни доложить факт, ни остановить листание.
 * Сам инжектор (поллер в странице) юнит-тестами не покрыт (нет DOM) — только node --check + живой смоук.
 */

/** Мок ext.tabAct с ЯВНОЙ сигнатурой — иначе mock.calls типизируется пустым кортежем и `[1]/[2]` не читаются. */
type TabAct = (url: string, intent: string, params?: Record<string, unknown>, tabId?: number) => Promise<unknown>;

function ctxWithExt(tabAct: ReturnType<typeof vi.fn<TabAct>>): ToolContext {
  return {
    session: {} as ToolContext["session"],
    userId: "u1",
    ext: { connected: true, tabAct, openOrFocus: vi.fn(async () => ({ tabId: 7, focused: false })) },
  } as unknown as ToolContext;
}

/** Цель (вкладка) берётся из browser_open — открываем ленту, как это делает модель перед листанием. */
async function openShorts(ctx: ToolContext): Promise<void> {
  await browserOpen(ctx, { url: "https://youtube.com/shorts/abc" });
}

describe("browser_act feed_auto — автолистание Shorts", () => {
  it("start: интент и лимиты доходят до расширения, ответ несёт running/advanced", async () => {
    const tabAct = vi.fn<TabAct>(async () => ({ ok: true, running: true, advanced: 0, maxCount: 30, maxMinutes: 20, note: "листаю следующий ролик" }));
    const ctx = ctxWithExt(tabAct);
    await openShorts(ctx);

    const r = await browserAct(ctx, { intent: "feed_auto", params: { action: "start", maxCount: 30, maxMinutes: 20 } });
    expect(r.isError).toBe(false);
    const call = tabAct.mock.calls.at(-1);
    expect(call?.[1]).toBe("feed_auto");
    expect(call?.[2]).toMatchObject({ action: "start", maxCount: 30, maxMinutes: 20 });
    // Модель должна ВИДЕТЬ состояние — иначе не доложит владельцу и не остановит листание.
    expect(String(r.content)).toMatch(/running/);
    expect(String(r.content)).toMatch(/maxCount/);
  });

  it("stop: возвращает, сколько роликов пролистал (честный факт для отчёта)", async () => {
    const tabAct = vi.fn<TabAct>(async () => ({ ok: true, running: false, advanced: 12, note: "автолистание остановлено" }));
    const ctx = ctxWithExt(tabAct);
    await openShorts(ctx);

    const r = await browserAct(ctx, { intent: "feed_auto", params: { action: "stop" } });
    expect(r.isError).toBe(false);
    expect(tabAct.mock.calls.at(-1)?.[2]).toMatchObject({ action: "stop" });
    expect(String(r.content)).toMatch(/"advanced":12/);
  });

  it("status: причина самоостановки (лимит) доходит до модели, а не теряется", async () => {
    const tabAct = vi.fn<TabAct>(async () => ({ ok: true, running: false, advanced: 50, stoppedReason: "достигнут лимит роликов" }));
    const ctx = ctxWithExt(tabAct);
    await openShorts(ctx);

    const r = await browserAct(ctx, { intent: "feed_auto", params: { action: "status" } });
    expect(String(r.content)).toMatch(/достигнут лимит роликов/);
  });

  it("нет видео на странице → ЧЕСТНАЯ ошибка (не молчаливое «сделал»)", async () => {
    const tabAct = vi.fn<TabAct>(async () => {
      throw new Error("tab.act feed_auto: на странице нет видимого видео — открой ленту коротких видео (Shorts) и повтори");
    });
    const ctx = ctxWithExt(tabAct);
    await openShorts(ctx);

    const r = await browserAct(ctx, { intent: "feed_auto", params: { action: "start" } });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/нет видимого видео/);
  });

  // Ревью (CRITICAL): счётчик обязан отражать СОСТОЯВШИЕСЯ переключения. Инжектор подтверждает смену
  // ролика по currentSrc; сервер лишь честно доносит цифру — здесь проверяем, что она не теряется.
  it("не удалось переключить → причина доходит до модели (не «пролистал N» вслепую)", async () => {
    const tabAct = vi.fn<TabAct>(async () => ({
      ok: true, running: false, advanced: 0, stoppedReason: "не удалось переключить ролик (кнопка «Следующее» не сработала)",
    }));
    const ctx = ctxWithExt(tabAct);
    await openShorts(ctx);

    const r = await browserAct(ctx, { intent: "feed_auto", params: { action: "status" } });
    expect(String(r.content)).toMatch(/не удалось переключить ролик/);
    expect(String(r.content)).toMatch(/"advanced":0/);
  });

  it("ушли из ленты (SPA-переход) → честная причина остановки, а не молчаливое продолжение", async () => {
    const tabAct = vi.fn<TabAct>(async () => ({
      ok: true, running: false, advanced: 7, stoppedReason: "страница ушла из ленты коротких видео",
    }));
    const ctx = ctxWithExt(tabAct);
    await openShorts(ctx);

    const r = await browserAct(ctx, { intent: "feed_auto", params: { action: "status" } });
    expect(String(r.content)).toMatch(/ушла из ленты/);
    expect(String(r.content)).toMatch(/"advanced":7/);
  });

  it("без открытой вкладки — честный отказ, а не слепое действие в чужой вкладке", async () => {
    const tabAct = vi.fn<TabAct>(async () => ({ ok: true, running: true }));
    const ctx = ctxWithExt(tabAct); // browser_open НЕ вызывали → цели нет
    const r = await browserAct(ctx, { intent: "feed_auto", params: { action: "start" } });
    expect(r.isError).toBe(true);
    expect(tabAct).not.toHaveBeenCalled();
  });
});
