/**
 * ПРОВОДКА реестра каналов: client.env.installed → matchChannels → ctx.appChannels → инструмент.
 *
 * Зачем поведенческий тест (адверс-ревью 2026-09-01): цепочка держится на трёх присваиваниях в трёх
 * файлах, и ни одно не проверялось. Тест хендлера подставлял appChannels руками — то есть проверял
 * форматирование, а не то, что данные с машины ВООБЩЕ доезжают. Ровно тот класс, на котором проект
 * уже обжигался (мёртвый gateStoppedRound, мёртвый uncertainCalls.add).
 *
 * Реверт-проверка (прогнана): снятие `ctx.agentDeps.appChannels = matchChannels(...)` в router-ws
 * роняет оба кейса.
 */
import { describe, expect, it, vi } from "vitest";
import type { ClientEnv } from "@jarvis/protocol";
import { channelSummary, matchChannels } from "../brain/app-channels.js";
import { dispatchTool, type ToolContext } from "../brain/tools/dispatch.js";
import { dispatch } from "./router-ws.js";

/** Минимальный ctx сессии: нам нужен только agentDeps, куда кладётся реестр. */
function sessionCtx() {
  return {
    agentDeps: {} as { appChannels?: ReturnType<typeof matchChannels> },
    envLexicon: { apps: [] as string[], games: [] as string[] },
    session: { send: vi.fn() },
  } as unknown as Parameters<typeof dispatch>[0] & { agentDeps: { appChannels?: ReturnType<typeof matchChannels> } };
}

const envelope = (payload: ClientEnv) => ({ id: "e1", type: "client.env", payload }) as Parameters<typeof dispatch>[1];

describe("реестр каналов доезжает с машины до инструмента", () => {
  it("client.env со списком установленного наполняет ctx.appChannels", async () => {
    const ctx = sessionCtx();
    await dispatch(ctx, envelope({ summary: "тест", installed: [{ name: "Steam", exe: "steam.exe", uri: "steam" }] }));
    expect(ctx.agentDeps.appChannels?.some((c) => c.app === "Steam")).toBe(true);
  });

  it("и оттуда доходит до app_channels и до паспорта возможностей", async () => {
    const ctx = sessionCtx();
    await dispatch(ctx, envelope({ summary: "тест", installed: [{ name: "OBS Studio", exe: "obs64.exe" }] }));
    const chans = ctx.agentDeps.appChannels ?? [];
    expect(channelSummary(chans)).toContain("OBS Studio");

    const toolCtx = { userId: "u1", appChannels: chans, session: { sendAction: vi.fn() } } as unknown as ToolContext;
    const out = await dispatchTool("app_channels", { app: "obs" }, toolCtx);
    expect(String(out.content)).toContain("obs-websocket");
  });

  it("client.env БЕЗ installed не ломает сессию и не выдумывает реестр", async () => {
    const ctx = sessionCtx();
    await dispatch(ctx, envelope({ summary: "тест" }));
    expect(ctx.agentDeps.appChannels).toBeUndefined();
  });
});
