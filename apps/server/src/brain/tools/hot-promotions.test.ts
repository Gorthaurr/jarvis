/**
 * Причина №5 USER_SCENARIOS_2026-09-02 («ежедневные инструменты в COLD»): (а) obs_request/office_* греются ПО
 * ФАКТУ установленной программы — чистая функция и проводка через РЕАЛЬНУЮ петлю (набор tools первого же запроса
 * к модели); (б) бытовые telegram_read/fs_move/fs_delete/fs_mkdir/system_power/system_lock — горячие всегда.
 * Тест ПЕТЛЁЙ, а не грепом по COLD_TOOL_NAMES: проводка promoted → isHot → tools живёт в runAgentLoop.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { COLD_TOOL_NAMES } from "@jarvis/tools";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { type AgentDeps, handleUserText } from "../agent/index.js";
import { CHANNEL_RECIPES, type MatchedChannel, matchChannels } from "../app-channels.js";
import { TaskManager } from "../tasks/manager.js";
import { PROMOTION_BY_APP, hotPromotionsFor } from "./hot-promotions.js";

function session(): Session {
  return {
    sessionId: "s1",
    userId: "u1",
    sendAction: vi.fn((_cmd: ActionCommand) => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 })),
    send: vi.fn(),
  } as unknown as Session;
}
function channel(app: string): MatchedChannel {
  return { app, installedAs: app, kind: "api", howTo: "", verify: "", limits: "" } as unknown as MatchedChannel;
}
function deps(llm: MockLlmProvider, appChannels?: MatchedChannel[]): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks: new TaskManager(),
    toolActivation: new Set<string>(),
    ...(appChannels ? { appChannels } : {}),
  } as AgentDeps;
}
const toolNames = (llm: MockLlmProvider): string[] => (llm.requests[0]?.tools ?? []).map((t) => t.name);

describe("hotPromotionsFor (чистая)", () => {
  it("OBS Studio → obs_request; Word/Excel → office_*; прочие приложения и пустой список → ничего", () => {
    expect([...hotPromotionsFor([channel("OBS Studio")])]).toEqual(["obs_request"]);
    expect([...hotPromotionsFor([channel("Microsoft Word"), channel("Microsoft Excel")])].sort()).toEqual(["office_excel", "office_word"]);
    expect(hotPromotionsFor([channel("Steam"), channel("Git")]).size).toBe(0);
    expect(hotPromotionsFor(undefined).size).toBe(0);
  });

  it("предпосылка: промоутируемые инструменты действительно холодные по умолчанию", () => {
    for (const n of ["obs_request", "office_word", "office_excel"]) expect(COLD_TOOL_NAMES.has(n), n).toBe(true);
  });

  it("ПРИВЯЗКА к рецептам (ревью): каждый ключ PROMOTION_BY_APP — имя реального рецепта; реальный matchChannels по exe/URI даёт промоут", () => {
    const apps = new Set(CHANNEL_RECIPES.map((r) => r.app));
    for (const key of PROMOTION_BY_APP.keys()) expect(apps.has(key), `рецепт «${key}» переименован/удалён — промоут молча умрёт`).toBe(true);
    // OBS — по exe из DisplayIcon; Word/Excel на Click-to-Run — по URI-схеме (exe в реестре нет — см. system-profiler).
    expect([...hotPromotionsFor(matchChannels([{ name: "OBS Studio", exe: "obs64.exe" }]))]).toEqual(["obs_request"]);
    expect([...hotPromotionsFor(matchChannels([{ name: "ms-word:", exe: "protocolhandler.exe", uri: "ms-word" }]))]).toEqual(["office_word"]);
    expect(hotPromotionsFor(matchChannels([{ name: "Steam", exe: "steam.exe" }])).size).toBe(0);
  });
});

describe("проводка через петлю: набор tools первого запроса к модели", () => {
  it("с каналом OBS Studio схема obs_request уходит модели БЕЗ tool_load и исчезает из каталога холодных", async () => {
    const llm = new MockLlmProvider([{ text: "Сцена переключена, сэр." }]);
    await handleUserText(session(), "сделай так, чтобы стрим шёл с игровой сцены", deps(llm, [channel("OBS Studio")]));
    expect(toolNames(llm)).toContain("obs_request");
    expect(String(llm.requests[0]?.systemTools ?? "")).not.toContain("obs_request");
    expect(toolNames(llm)).not.toContain("office_word"); // Word не установлен — не греем
  });

  it("без канала OBS схема obs_request НЕ в наборе, но остаётся в каталоге холодных (tool_load как раньше)", async () => {
    const llm = new MockLlmProvider([{ text: "Слушаю, сэр." }]);
    await handleUserText(session(), "сделай так, чтобы стрим шёл с игровой сцены", deps(llm, [channel("Steam")]));
    expect(toolNames(llm)).not.toContain("obs_request");
    expect(String(llm.requests[0]?.systemTools ?? "")).toContain("obs_request");
  });

  it("бытовые инструменты горячие всегда: telegram_read/fs_move/fs_delete/fs_mkdir/system_power/system_lock в наборе без tool_load", async () => {
    const llm = new MockLlmProvider([{ text: "Готово, сэр." }]);
    await handleUserText(session(), "разложи скачанные отчёты по папкам за месяц", deps(llm));
    const names = toolNames(llm);
    for (const n of ["telegram_read", "fs_move", "fs_delete", "fs_mkdir", "system_power", "system_lock"]) expect(names, n).toContain(n);
  });
});
