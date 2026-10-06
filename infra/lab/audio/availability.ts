/**
 * Можно ли строить аудио-стенд на этой машине — БЕЗ загрузки нативного sherpa (для skipIf в тестах). Причина — человеческая:
 * тест, который тихо пропускается, не отличить от зелёного (урок D3 карты), поэтому skip всегда несёт reason.
 */
import { existsSync } from "node:fs";
import { hearingModelsDir, hearingModelsPresent, isAsciiPath } from "../../../apps/client/main/hearing/sherpa-hearing.js";
import { repoRoot } from "../lib/deps.js";

export const CORPUS_DIR: string = repoRoot("apps/client/test-audio");

export function deepgramLiveReason(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LAB_SKIP_LIVE === "1") return "LAB_SKIP_LIVE=1";
  return env.LAB_LIVE_DEEPGRAM === "1" ? "" : "нужен явный LAB_LIVE_DEEPGRAM=1 для платного STT";
}

export function audioStandAvailability(dir = hearingModelsDir()): { ok: boolean; reason: string } {
  if (!isAsciiPath(dir)) return { ok: false, reason: `каталог моделей слуха не ASCII: ${dir}` };
  if (!hearingModelsPresent(dir)) return { ok: false, reason: `нет моделей слуха в ${dir} (node apps/client/scripts/fetch-hearing-models.mjs)` };
  if (!existsSync(`${CORPUS_DIR}/pos_filipp_1.wav`)) return { ok: false, reason: `нет корпуса WAV в ${CORPUS_DIR}` };
  return { ok: true, reason: "" };
}
