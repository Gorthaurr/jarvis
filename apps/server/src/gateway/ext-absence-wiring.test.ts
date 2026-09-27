/**
 * ПРОВОДКА доклада об отсутствии расширения: client.context → extAbsence().tick; реплика владельца (dev.text →
 * onDevText → onOwnerPresent) → flushExtAbsence → голос + чат. Юнит-тест трекера строит его руками и не видит,
 * что тик/флаш вообще подключены — ровно класс «механизм есть, а до владельца не доходит» (27.09: трое суток).
 *
 * Реверт-проверки: убрать `extAbsence().tick(...)` из case "client.context" → падает первый кейс;
 * убрать `flushExtAbsenceForOwner(...)` из onOwnerPresent → тоже он; убрать гейт ownerBusy → кейс «занят»;
 * игнорировать `skip` → кейсы dev-сессии и продуктового режима; не передать locked в тик → кейс «экран заблокирован»;
 * убрать голос из флаша → первый кейс.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientContext } from "@jarvis/protocol";
import { SpendGuard } from "../billing/index.js";
import { TaskManager } from "../brain/tasks/manager.js";
import { MockLlmProvider } from "../integrations/llm.js";
import { HashEmbeddingProvider } from "../integrations/openai-embeddings.js";
import { MockSttProvider, MockTtsProvider } from "../integrations/voice-providers.js";
import { MockWebProvider } from "../integrations/web.js";
import { InMemoryEpisodicMemory } from "../memory/episodic.js";
import { CHROME_EVIDENCE_MS, ExtAbsence, STRONG_ABSENT_MS, setExtAbsenceForTests } from "./ext-absence.js";
import { dispatch, makeSessionContext, type BrainProviders } from "./router-ws.js";
import type { Session } from "./session.js";

type Sent = Array<{ type: string; payload: { text?: string } }>;

function fakeSession(sent: Sent): Session {
  const scopes = new Map<string, unknown>();
  return {
    sessionId: "s1",
    userId: "u1",
    send: vi.fn((type: string, payload: { text?: string }) => void sent.push({ type, payload })),
    sendAction: vi.fn(async () => ({ commandId: "c", ok: true, durationMs: 1 })),
    requestConfirm: vi.fn(),
    onTeardown: vi.fn(),
    channelUp: () => true,
    scoped: <T>(key: string, init: () => T): T => {
      if (!scopes.has(key)) scopes.set(key, init());
      return scopes.get(key) as T;
    },
  } as unknown as Session;
}

function setup(opts: { clientVersion?: string; connected?: boolean; product?: boolean } = {}) {
  const clock = { t: Date.UTC(2026, 8, 24, 18, 0) };
  const tracker = new ExtAbsence(() => join(mkdtempSync(join(tmpdir(), "ext-abs-wire-")), "ext-presence.json"), () => clock.t);
  setExtAbsenceForTests(tracker);
  const sent: Sent = [];
  const brain = {
    llm: new MockLlmProvider([]),
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: { forUser: () => new SpendGuard() },
    tasks: new TaskManager(),
    extBridge: { connected: opts.connected ?? false, telegramSend: vi.fn(), telegramSendVoice: vi.fn(), openOrFocus: vi.fn() },
    ...(opts.product ? { product: productStub() } : {}),
  } as unknown as BrainProviders;
  const providers = { stt: new MockSttProvider(), tts: new MockTtsProvider() } as never;
  const ctx = makeSessionContext(fakeSession(sent), { stop: vi.fn() } as never, providers, brain, opts.clientVersion ?? "0.1.0");
  const speakQueued = vi.spyOn(ctx.voice, "speakQueued");
  const context = (c: Partial<ClientContext>) =>
    dispatch(ctx, { id: "e", type: "client.context", payload: { activeApp: "chrome", fullscreen: false, micBusyByOtherApp: false, locked: false, ...c } } as never);
  /** Клиент живёт ms, шлёт client.context раз в 15 с (Chrome на переднем плане). */
  const live = async (ms: number, c: Partial<ClientContext> = {}) => {
    for (let passed = 0; passed <= ms; passed += 15_000) {
      clock.t += 15_000;
      await context(c);
    }
  };
  const say = (text: string) => dispatch(ctx, { id: "t", type: "dev.text", payload: { text } } as never);
  const extReports = () => sent.filter((m) => m.type === "chat" && String(m.payload.text).includes("chrome://extensions"));
  /** Учёт, накопленный СЕССИЕЙ ВЛАДЕЛЬЦА (тики мимо этого ctx). */
  const ownerObserved = (ms: number) => {
    for (let passed = 0; passed <= ms; passed += 15_000) {
      clock.t += 15_000;
      tracker.tick("chrome", false);
    }
  };
  return { tracker, live, say, context, extReports, ownerObserved, speakQueued };
}

/** Продуктовый режим (арендаторы): ровно то, что makeSessionContext трогает при включённом режиме. */
function productStub() {
  const models = { haiku: "h", sonnet: "s", fable: "f" };
  return {
    policy: { enabled: true, quotas: false },
    modelsSync: () => models,
    modelsFor: async () => ({ models }),
    modelsCatalogFor: async () => ({}),
    modelsCatalogFallback: () => ({}),
    quotaExhaustedText: () => undefined,
    usageSinkFor: () => undefined,
    attachThreshold: vi.fn(),
    detachThreshold: vi.fn(),
  };
}

afterEach(() => setExtAbsenceForTests(undefined));

describe("доклад об отсутствии расширения доходит до владельца", () => {
  it("Chrome открыт 2+ ч без расширения → на реплике владельца доклад в чат (с шагами) и голосом, один раз", async () => {
    const s = setup();
    await s.live(STRONG_ABSENT_MS + CHROME_EVIDENCE_MS);
    await s.say("который час");
    expect(s.extReports()).toHaveLength(1);
    expect(s.extReports()[0]?.payload.text).toMatch(/Chrome был у вас на экране.*Загрузить распакованное/);
    const voiced = s.speakQueued.mock.calls.map((c) => String(c[0]));
    expect(voiced.filter((v) => v.includes("расширение так и не вышло на связь"))).toHaveLength(1); // голос — основной канал
    await s.live(60 * 60_000);
    await s.say("а сейчас");
    expect(s.extReports()).toHaveLength(1); // не спамим до восстановления связи
  });

  it("владелец занят (полный экран) → молчим и флаг НЕ тратим; освободился → докладываем", async () => {
    const s = setup();
    await s.live(STRONG_ABSENT_MS + CHROME_EVIDENCE_MS, { fullscreen: true });
    await s.say("пауза");
    expect(s.extReports()).toHaveLength(0);
    expect(s.tracker.due(false)).not.toBeNull();
    await s.context({ fullscreen: false });
    await s.say("всё, я тут");
    expect(s.extReports()).toHaveLength(1);
  });

  it("расширение на связи → тики гасят учёт, доклада нет", async () => {
    const s = setup({ connected: true });
    await s.live(STRONG_ABSENT_MS + CHROME_EVIDENCE_MS);
    await s.say("который час");
    expect(s.extReports()).toHaveLength(0);
    expect(s.tracker.due(false)).toBeNull();
  });

  it("экран заблокирован (ночь с включённым ПК) — не наблюдение: тики не копят отсутствие", async () => {
    const s = setup();
    await s.live(13 * 60 * 60_000, { activeApp: "explorer", locked: true });
    await s.context({ activeApp: "explorer", locked: false });
    await s.say("доброе утро");
    expect(s.extReports()).toHaveLength(0);
    expect(s.tracker.due(false)).toBeNull();
  });

  it("продуктовый режим: ПК арендатора не копит учёт, доклад владельца арендатору не уходит", async () => {
    const s = setup({ product: true });
    await s.live(STRONG_ABSENT_MS + CHROME_EVIDENCE_MS);
    expect(s.tracker.due(false)).toBeNull();
    s.ownerObserved(STRONG_ABSENT_MS + CHROME_EVIDENCE_MS);
    await s.say("который час");
    expect(s.extReports()).toHaveLength(0);
    expect(s.tracker.due(false)).not.toBeNull();
  });

  it("dev-сессия (текст-драйвер) не копит учёт и не съедает доклад владельца", async () => {
    const s = setup({ clientVersion: "jarvis-cmd" });
    await s.live(STRONG_ABSENT_MS + CHROME_EVIDENCE_MS);
    await s.say("который час");
    expect(s.extReports()).toHaveLength(0);
    expect(s.tracker.due(false)).toBeNull(); // её client.context — не наблюдение за ПК владельца
    s.ownerObserved(STRONG_ABSENT_MS + CHROME_EVIDENCE_MS);
    await s.say("который час");
    expect(s.extReports()).toHaveLength(0);
    expect(s.tracker.due(false)).not.toBeNull(); // доклад остался владельцу
  });
});
