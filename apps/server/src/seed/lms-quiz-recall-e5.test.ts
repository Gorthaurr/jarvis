/**
 * 27.09 (живой прогон владельца): на «это мой учебный портал, Пройди все мини-тесты во всех курсах.» recall навыка
 * Moodle был, но подсказка в промпт не шла — сперва гейт «нет командного глагола», а за ним сырой косинус 0.802
 * при пороге 0.86 (retrieval.ts). Проверка — НАСТОЯЩИМ e5 (тот же multilingual-e5-small, что на сервере) по общей
 * библиотеке навыков, а не подставленным recallSimRaw. Нет модели в ~/.jarvis/models/hf (чистая машина/CI) — пропуск.
 * Формы STT (регистр, точка, дефис) e5-small на пороге не различает — их держат якоря навыка (memory/skill-anchors.ts).
 * Реверт: верни навык v3 (без якорей) — упадут оба первых теста; убери отрицание в task-verbs.ts — упадёт «жалоба».
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { skillHintBlockReason } from "../brain/agent/loop/retrieval.js";
import { LocalEmbeddingProvider, embedderCacheDir } from "../integrations/local-embeddings.js";
import { parseAnchors } from "../memory/skill-anchors.js";
import { recallSemantic } from "../memory/skill-recall.js";
import { type RecalledSkill, parseSkillMd } from "../memory/skills.js";
import { SHARED_SKILL_SEED } from "./shared-skills.js";

const MODEL = join(embedderCacheDir(), "intfloat", "multilingual-e5-small", "onnx", "model.onnx");
// Только локальные веса: сеть отрезана, чтобы тест не качал 470 МБ. На этой Windows CPU-EP onnxruntime сломан — DirectML.
process.env.HF_ENDPOINT = "http://127.0.0.1:9";
process.env.JARVIS_EMBED_DEVICE ??= process.platform === "win32" ? "dml" : "cpu";

const SHARED: RecalledSkill[] = SHARED_SKILL_SEED.map((md) => {
  const fm = parseSkillMd(md).frontmatter;
  return { id: String(fm.id), ownerId: "__shared__", name: String(fm.name), when: String(fm.description ?? ""), procedure: "", version: Number(fm.version), anchors: parseAnchors(fm.anchors) };
});
const emb = new LocalEmbeddingProvider();

/** Какой навык подсказка вставила бы в промпт на этой реплике (null — никакой). */
async function hinted(text: string): Promise<string | null> {
  const r = await recallSemantic(emb, text, SHARED);
  return r && skillHintBlockReason(r, text) === null ? r.id : null;
}

describe.skipIf(!existsSync(MODEL))("lms-quiz: подсказка навыка на живой e5", { timeout: 120_000 }, () => {
  it("реплика владельца дословно → в промпт идёт навык Moodle (порог косинуса или якорь навыка)", async () => {
    expect(await hinted("это мой учебный портал, Пройди все мини-тесты во всех курсах.")).toBe("learned__lms-quiz");
  });

  it("та же команда в формах STT (регистр, точка, без дефиса) и соседние приказы по ЭИОС → навык Moodle", async () => {
    for (const t of ["Пройди все мини-тесты во всех курсах.", "пройди все мини тесты во всех курсах", "Пройди тесты на учебном портале.", "проверь дедлайны в ЭИОС", "реши тест по экономике в ЭИОС"]) {
      expect(await hinted(t), t).toBe("learned__lms-quiz");
    }
  });

  it("чужие приказы с теми же глаголами и жалоба на портал навык Moodle НЕ получают", async () => {
    for (const t of ["пройди все уровни в доте", "пройди тест на IQ", "это мой портал госуслуг, проверь штрафы", "пройди регистрацию на сайте", "сдай отчёт начальнику", "не могу пройти мини-тест в ЭИОС, там ошибка", "пройди онлайн-курс на степике"]) {
      expect(await hinted(t), t).not.toBe("learned__lms-quiz");
    }
  });
});
