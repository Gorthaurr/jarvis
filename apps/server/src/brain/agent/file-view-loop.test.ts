/**
 * Проводка file_view через ПЕТЛЮ (правило аудита тестовой базы: механизмы проверяем handleUserText, не чистой функцией).
 *
 * Два дефекта адверс-ревью 2026-09-01, невидимых юнит-тестам:
 *  (1) HIGH — страницы, запрошенные ОДНИМ параллельным раундом (file_view page:1..3), сворачивались prune'ом
 *      ДО того, как модель их увидела (prune зовётся сразу после convo.push). Плюс env JARVIS_KEEP_DOC_IMAGES
 *      был неотличим от отсутствия (дефолт env = дефолт функции) — здесь бюджет 1 и 3 дают РАЗНЫЕ исходы.
 *  (2) MED — постраничное чтение (разные page) считалось флудом одним инструментом: на 6-й странице нудж
 *      «топтание» + Opus, на 12-й — ложный провал «Застрял на file_view».
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { type LlmMessage, MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

function session() {
  const sendAction = vi.fn((cmd: ActionCommand) =>
    Promise.resolve(
      cmd.kind === "fs.view"
        ? {
            commandId: "c",
            ok: true,
            data: { path: cmd.path, image: "UE5H", mediaType: "image/png", width: 10, height: 10, format: "pdf", bytes: 3, page: cmd.page ?? 1, pageCount: 20, resized: false, rendered: true },
            durationMs: 1,
          }
        : { commandId: "c", ok: true, durationMs: 1 },
    ),
  );
  return { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
}

function deps(llm: MockLlmProvider): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks: new TaskManager(),
  };
}

const fv = (id: string, page: number) => ({ id, name: "file_view", input: { path: "C:\r.pdf", page } });

/** image-блоки во ВСЕХ сообщениях запроса. */
function imagesInRequest(messages: LlmMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "tool_result" || typeof b.content === "string") continue;
      for (const c of b.content) if (c.type === "image") n += 1;
    }
  }
  return n;
}

const savedEnv = process.env.JARVIS_KEEP_DOC_IMAGES;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.JARVIS_KEEP_DOC_IMAGES;
  else process.env.JARVIS_KEEP_DOC_IMAGES = savedEnv;
});

describe("file_view в петле — страницы доезжают до модели, бюджет документов читается из env", () => {
  it("три file_view ОДНИМ раундом при JARVIS_KEEP_DOC_IMAGES=1 → следующий запрос несёт все три картинки (хвост не режется)", async () => {
    process.env.JARVIS_KEEP_DOC_IMAGES = "1";
    const llm = new MockLlmProvider([{ toolUses: [fv("a", 1), fv("b", 2), fv("c", 3)] }, { text: "Прочитал три страницы, сэр." }]);
    await handleUserText(session(), "прочитай отчёт r.pdf и перескажи", deps(llm));
    expect(llm.requests.length).toBeGreaterThanOrEqual(2);
    expect(imagesInRequest(llm.requests[1]!.messages)).toBe(3);
  });

  it("страницы по одной за раунд: env=1 оставляет одну картинку, env=3 — три (проводка третьего аргумента pruneStaleImages жива)", async () => {
    const script = () =>
      new MockLlmProvider([
        { toolUses: [fv("a", 1)] },
        { toolUses: [fv("b", 2)] },
        { toolUses: [fv("c", 3)] },
        { text: "Готово, сэр — три страницы прочитаны." },
      ]);
    process.env.JARVIS_KEEP_DOC_IMAGES = "1";
    const one = script();
    await handleUserText(session(), "прочитай отчёт r.pdf постранично", deps(one));
    expect(imagesInRequest(one.requests[3]!.messages)).toBe(1);

    process.env.JARVIS_KEEP_DOC_IMAGES = "3";
    const three = script();
    await handleUserText(session(), "прочитай отчёт r.pdf постранично", deps(three));
    expect(imagesInRequest(three.requests[3]!.messages)).toBe(3);
  });
});

describe("file_view в петле — постраничное чтение ≠ флуд одним инструментом", () => {
  const nudged = (llm: MockLlmProvider) => llm.requests.some((r) => JSON.stringify(r.messages).includes("топтание"));

  it("8 РАЗНЫХ страниц подряд → без нуджа «топтание», задача завершается ответом модели", async () => {
    const llm = new MockLlmProvider([
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((p) => ({ toolUses: [fv(`p${p}`, p)] })),
      { text: "Готово, сэр — отчёт прочитан, итог: всё в порядке." },
    ]);
    await handleUserText(session(), "прочитай отчёт r.pdf целиком и скажи итог", deps(llm));
    expect(nudged(llm)).toBe(false);
    expect(llm.requests.some((r) => JSON.stringify(r.messages).includes("Застрял"))).toBe(false);
    expect(llm.requests.length).toBeGreaterThanOrEqual(9); // все 8 страниц дошли до модели
  });

  it("регресс: та же страница 7 раз (разный maxSide, чтобы не сработал более ранний гард байт-в-байт повтора) — по-прежнему топтание", async () => {
    const same = (i: number) => ({ id: `s${i}`, name: "file_view", input: { path: "C:\\r.pdf", page: 1, maxSide: 300 + i * 100 } });
    const llm = new MockLlmProvider([...[1, 2, 3, 4, 5, 6, 7].map((i) => ({ toolUses: [same(i)] })), { text: "Готово." }, { text: "Готово." }]);
    await handleUserText(session(), "прочитай отчёт r.pdf", deps(llm));
    expect(nudged(llm)).toBe(true);
  });
});
