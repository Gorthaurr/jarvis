/**
 * Ревью 2026-09-24 (T-F2): подсказка навыка в промпт — только уверенному recall на КОМАНДУ.
 *
 * Живой корень (09.09): recall на шумном e5 приносил навык с sim 0.84–1.0 на реплику «нет, не надо», а блок
 * промпта приказывал «ИСПОЛНИ… не отвечай болтовнёй» — модель лезла в браузер вместо ответа. Проверяем ПЕТЛЁЙ:
 * что реально уходит в systemSkill запроса к модели. Реплей-гейт (0.84/0.92) не трогаем — recall как таковой жив.
 * Реверт-проверка: убери вызов suppressSkillHint в loop/retrieval.ts — первые два теста упадут.
 */
import { describe, expect, it, vi } from "vitest";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import type { RecalledSkill, SkillProvider } from "../../memory/skills.js";
import { WorkingMemory } from "../../memory/working.js";
import { type AgentDeps, handleUserText } from "./index.js";
import { SKILL_HINT_MIN_RAW_COS, skillHintBlockReason } from "./loop/retrieval.js";
import { formatRecalledSkill } from "./loop/util.js";

const SKILL: RecalledSkill = {
  id: "learned__yandex-music",
  ownerId: "u1",
  name: "Управление Яндекс.Музыкой",
  when: "включить или поставить на паузу музыку в браузере",
  procedure: "1. browser_open music.yandex.ru\n2. browser_act play",
  version: 3,
  recallSim: 1.0,
  recallSimRaw: 0.95,
};

function run(text: string, skill: RecalledSkill | null) {
  const llm = new MockLlmProvider([{ text: "Понял, сэр." }]);
  const skills: SkillProvider = {
    list: async () => [],
    get: async () => null,
    save: async () => null,
    recall: vi.fn(async () => (skill ? { ...skill } : null)),
    learnedCatalog: async () => [{ name: SKILL.name, when: SKILL.when }],
  };
  const deps: AgentDeps = {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    skills,
  };
  const session = { sessionId: "s1", userId: "u1", sendAction: vi.fn(), send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
  return handleUserText(session, text, deps).then(() => llm.requests[0]);
}

describe("T-F2: навык не подсказывается на реакцию/вопрос и на шумный recall", () => {
  it("реакция «нет, не надо» + навык с sim 1.0 → в промпте НЕТ блока навыка (есть каталог)", async () => {
    const req = await run("нет, не надо", SKILL);
    expect(req?.systemSkill ?? "").toBe("");
    expect(req?.systemDynamic ?? "").toContain("Твои выученные навыки"); // модель видит навыки по именам и решает сама
  });

  it("вопрос без командного глагола + уверенный recall → блока нет", async () => {
    const req = await run("а что там сейчас с музыкой", SKILL);
    expect(req?.systemSkill ?? "").toBe("");
  });

  it("команда, но сырой косинус ниже 0.86 (полоса шума e5) → блока нет", async () => {
    const req = await run("включи музыку в браузере", { ...SKILL, recallSimRaw: 0.85 });
    expect(req?.systemSkill ?? "").toBe("");
  });

  it("команда + уверенный recall → блок есть, и он НЕ приказывает «действуй, не болтай», а разрешает игнорировать", async () => {
    const req = await run("включи музыку в браузере", SKILL);
    const block = req?.systemSkill ?? "";
    expect(block).toContain("Управление Яндекс.Музыкой");
    expect(block).not.toMatch(/не отвечай одной болтовнёй/u);
    expect(block).toMatch(/игнорируй его ПОЛНОСТЬЮ/u);
  });

  it("лексический recall (без косинуса) на команду → блока нет: уверенности нет", async () => {
    const req = await run("включи музыку в браузере", { ...SKILL, recallSim: undefined, recallSimRaw: undefined });
    expect(req?.systemSkill ?? "").toBe("");
  });
});

describe("skillHintBlockReason — чистые гейты", () => {
  it("разговорный ход блокирует даже уверенный recall на команду; порог — ровно 0.86", () => {
    expect(skillHintBlockReason(SKILL, "включи музыку", true)).toMatch(/разговорный/u);
    expect(skillHintBlockReason({ ...SKILL, recallSimRaw: SKILL_HINT_MIN_RAW_COS }, "включи музыку")).toBeNull();
    expect(skillHintBlockReason({ ...SKILL, recallSimRaw: 0.859 }, "включи музыку")).toMatch(/0\.859/u);
  });

  it("подавленный навык formatRecalledSkill отдаёт пустым (блок не рисуется), обычный — полным", async () => {
    const { suppressSkillHint } = await import("./loop/util.js");
    const a = { ...SKILL };
    const b = { ...SKILL };
    suppressSkillHint(a);
    expect(formatRecalledSkill(a)).toBe("");
    expect(formatRecalledSkill(b)).toContain(SKILL.procedure);
  });
});

describe("T-F2 проводка: разговорный ход с командным инфинитивом тоже без подсказки навыка", () => {
  // Раньше гейт conversational проверялся только чистой функцией: context.ts не передавал флаг в retrieveContext,
  // и вопрос «как включить музыку в браузере?» (командный инфинитив) получал навык с приказом действовать.
  it("вопрос «как включить музыку в браузере?» + уверенный recall → блока нет", async () => {
    const req = await run("как включить музыку в браузере?", SKILL);
    expect(req?.systemSkill ?? "").toBe("");
  });
});
