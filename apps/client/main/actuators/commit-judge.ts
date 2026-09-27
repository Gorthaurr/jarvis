/**
 * W2 (пакет 0): судья «commit» (§14) рубежа инжекции — ЗАГЛУШКА (null: пропускает). Реализует П1.
 * Категория процесса цели (guiProcessCategory: handle → pid зеркала, точка → windowAt, клавиатура → передний план) ×
 * намерение (opCommitIntent по фактам); грант из области (findGrant) списывается, нет — denied + needsApproval;
 * вне области сервера (мост/реплей/UI) — отказ fail-closed. Пока рубеж §14 держат commit-guard.ts и серверный гейт.
 */
import type { Judge } from "./injection-guard.js";

export const commitJudge: Judge = async () => null;
