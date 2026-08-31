/**
 * САМОПРАВКА ПОД РЕЛЬСАМИ (волна I, 2026-08-31 — «хочу, чтобы он себя редактировал»).
 *
 * Технически Джарвис мог править свой код и раньше (fs_edit + code_run). Чего не было — БЕЗОПАСНОГО
 * ЗАВЕРШЁННОГО цикла: правка шла бы прямо в рабочую ветку, без прогона тестов, без возможности
 * откатить и без решения владельца. Здесь цикл выражен явно:
 *   begin (своя ветка) → правка обычными инструментами → verify (компилятор+тесты) → commit → apply.
 *
 * 🔴 Рельсы, которые нельзя снимать изнутри (иначе автономная правка однажды снимет их сама —
 * классический сценарий «песочница, снимающая себя»):
 *  1. Работаем ТОЛЬКО в отдельной ветке `self/*` и только от чистого дерева: чужие незакоммиченные
 *     правки владельца не подмешиваем и не теряем.
 *  2. Список ЗАПРЕТНЫХ файлов (`PROTECTED_PATHS`) — гейты честности, согласия §14, killswitch,
 *     предохранители, рельсы записи и сам этот модуль. Тронуты — правка не проходит проверку и не
 *     предлагается; такие изменения делает владелец руками.
 *  3. Применение (merge) — ТОЛЬКО после зелёной проверки И подтверждения владельца.
 *  4. Заморозка автономии (killswitch) выключает весь цикл — проверяется вызывающей стороной.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { lazyDataPath } from "../paths.js";
import { selfRepoRoot } from "./repo.js";
import { verifyChanges, type VerifyOutcome } from "./verify.js";

const statePath = lazyDataPath("self-patch.json");

/**
 * Файлы, которые самоправка не трогает. Это не «важный код» вообще, а именно ОГРАНИЧИТЕЛИ самой
 * автономии: сними их — и следующая правка пройдёт уже без тормозов.
 */
export const PROTECTED_PATHS = [
  "apps/server/src/self/patch.ts",
  "apps/server/src/self/verify.ts",
  "apps/server/src/autonomy/freeze.ts",
  "apps/server/src/autonomy/throttle.ts",
  "apps/server/src/brain/consent.ts",
  "apps/server/src/brain/messaging/resend-guard.ts",
  "apps/server/src/brain/messaging/delivery-check.ts",
  "apps/server/src/brain/messaging/cadence.ts",
  "apps/server/src/brain/tools/handlers/messaging.ts",
  // Здесь живут killswitch-гейт самоправки и §14-подтверждение на apply: сними их — и следующий
  // цикл применит себя сам, не спросив владельца (ревью волны I, HIGH).
  "apps/server/src/brain/tools/handlers/self.ts",
  "apps/server/src/gateway/session.ts",
  "apps/server/src/brain/messaging/outbound.ts",
  "apps/server/src/brain/orders/order-guard.ts",
  "apps/server/src/brain/tools/dispatch-util.ts",
  "apps/server/src/brain/agent/error-voice.ts",
  "apps/server/src/gateway/bind.ts",
  "apps/client/main/actuators/self-guard.ts",
  "infra/supervisor.mjs",
  "mcp.json",
  // Конфигурация проверки — тоже ограничитель (см. PROTECTED_CONFIG ниже).
  "apps/server/vitest.setup.ts",
  "package.json",
  "apps/server/package.json",
  "apps/client/package.json",
  "tsconfig.json",
  "apps/server/tsconfig.json",
  "apps/client/tsconfig.json",
] as const;

/**
 * 🔴 Файлы, которых в репозитории СЕЙЧАС НЕТ, но появление которых само по себе меняет правила игры:
 * конфиг vitest может исключить тесты из прогона, и «проверил, всё зелено» станет ложью — а на этот
 * прогон опирается подтверждение владельца. Держим отдельно от PROTECTED_PATHS честности ради:
 * первый список описывает существующий код (и сверяется тестом), этот — превентивный запрет.
 */
export const PROTECTED_CONFIG = [
  "vitest.config.ts",
  "vitest.config.mts",
  "apps/server/vitest.config.ts",
  "apps/client/vitest.config.ts",
] as const;

/** Тронуты ли рельсы (сравнение по нормализованному пути, регистр Windows не должен создавать дыру). */
export function protectedHits(changedFiles: readonly string[]): string[] {
  const guard = new Set([...PROTECTED_PATHS, ...PROTECTED_CONFIG].map((p) => p.toLowerCase()));
  return changedFiles.map((f) => f.replace(/\\/g, "/")).filter((f) => guard.has(f.toLowerCase()) || /(^|\/)\.env($|\.)/i.test(f));
}

export interface SelfPatchState {
  branch: string;
  baseBranch: string;
  title: string;
  startedAt: string;
  stage: "open" | "verified" | "committed";
  lastVerify?: { ok: boolean; summary: string; at: string };
  /**
   * 🔴 Отпечаток ПРОВЕРЕННОГО дерева (ревью волны I, HIGH): зелёная проверка относится к конкретному
   * содержимому файлов. Между verify и commit модель (в том числе под инъекцией с прочитанной
   * страницы) может дописать что угодно — включая снятие собственных ограничителей, — а `git add -A`
   * утащил бы это в коммит под отчёт «проверено, зелено». Поэтому фиксируем и сверяем.
   */
  verifiedFingerprint?: string;
}

function git(args: readonly string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolvePromise) => {
    execFile("git", [...args], { cwd: selfRepoRoot(), timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolvePromise({ ok: !error, out: `${stdout ?? ""}${stderr ?? ""}`.trim() });
    });
  });
}

export async function loadState(): Promise<SelfPatchState | undefined> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as SelfPatchState;
  } catch {
    return undefined;
  }
}

async function saveState(state: SelfPatchState | undefined): Promise<void> {
  if (!state) {
    await rm(statePath(), { force: true }).catch(() => undefined);
    return;
  }
  await writeFile(statePath(), JSON.stringify(state, null, 2), "utf8");
}

/** Имя ветки из темы правки: только безопасные символы, иначе git-аргумент станет непредсказуемым. */
export function branchNameFor(title: string, today: string): string {
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `self/${today}-${slug || "patch"}`;
}

export interface RepoStatus {
  branch: string;
  dirty: boolean;
  changedFiles: string[];
}

export async function repoStatus(): Promise<RepoStatus> {
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).out.trim();
  const porcelain = (await git(["status", "--porcelain"])).out;
  const changedFiles = porcelain
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.slice(3).trim().split(" -> ").pop() ?? "")
    .filter(Boolean);
  return { branch, dirty: changedFiles.length > 0, changedFiles };
}

export interface PatchOutcome {
  ok: boolean;
  message: string;
  state?: SelfPatchState;
  verify?: VerifyOutcome;
}

/** Открыть цикл самоправки: своя ветка от ЧИСТОГО дерева. */
export async function beginSelfPatch(title: string, today: string): Promise<PatchOutcome> {
  const existing = await loadState();
  if (existing) return { ok: false, message: `Уже открыта правка «${existing.title}» в ветке ${existing.branch} (стадия ${existing.stage}). Сначала заверши или отмени её.`, state: existing };
  const status = await repoStatus();
  if (status.dirty) {
    return {
      ok: false,
      message: `В рабочем дереве есть незакоммиченные изменения (${status.changedFiles.slice(0, 5).join(", ")}). Свою правку в них не подмешиваю — сохраните или откатите их.`,
    };
  }
  const branch = branchNameFor(title, today);
  const created = await git(["checkout", "-b", branch]);
  if (!created.ok) return { ok: false, message: `Не смог создать ветку ${branch}: ${created.out.slice(0, 300)}` };
  const state: SelfPatchState = { branch, baseBranch: status.branch, title: String(title ?? "").slice(0, 200), startedAt: new Date().toISOString(), stage: "open" };
  await saveState(state);
  return { ok: true, message: `Открыл правку «${state.title}» в ветке ${branch} (от ${status.branch}).`, state };
}

/**
 * Отпечаток текущего состояния правки: пути + хеши содержимого. `git status --porcelain` даёт только
 * список файлов (правка внутри файла его не меняет), поэтому берём хеши объектов из индекса и дерева.
 */
async function treeFingerprint(state: SelfPatchState): Promise<string> {
  await git(["add", "-A"]); // чтобы новые файлы попали в ls-files -s
  const staged = (await git(["ls-files", "-s"])).out;
  const head = (await git(["rev-parse", "HEAD"])).out.trim();
  return `${head}|${createHash("sha256").update(staged).digest("hex")}`;
}

/** Что изменено в текущем цикле (рабочее дерево + уже сделанные коммиты ветки). */
export async function patchChangedFiles(state: SelfPatchState): Promise<string[]> {
  const working = (await repoStatus()).changedFiles;
  const committed = (await git(["diff", "--name-only", `${state.baseBranch}...HEAD`])).out.split(/\r?\n/).filter(Boolean);
  return [...new Set([...working, ...committed])];
}

/** Проверить правку: рельсы + компилятор + тесты. Зелено — только если ВСЁ зелено. */
export async function verifySelfPatch(): Promise<PatchOutcome> {
  const state = await loadState();
  if (!state) return { ok: false, message: "Открытой правки нет — начинать проверку нечего." };
  const changed = await patchChangedFiles(state);
  if (changed.length === 0) return { ok: false, message: "В ветке правки нет изменений — проверять нечего.", state };
  const hits = protectedHits(changed);
  if (hits.length > 0) {
    return {
      ok: false,
      message: `Правка трогает мои ограничители: ${hits.join(", ")}. Такое я себе не разрешаю — это делает владелец руками.`,
      state,
    };
  }
  const verify = await verifyChanges(changed);
  const next: SelfPatchState = {
    ...state,
    stage: verify.ok ? "verified" : "open",
    lastVerify: { ok: verify.ok, summary: verify.summary, at: new Date().toISOString() },
    ...(verify.ok ? { verifiedFingerprint: await treeFingerprint(state) } : {}),
  };
  await saveState(next);
  return { ok: verify.ok, message: verify.ok ? `Проверил: ${verify.summary} Изменено файлов: ${changed.length}.` : `Не готово. ${verify.summary}`, state: next, verify };
}

/** Зафиксировать правку в ветке. Требует зелёной проверки — иначе фиксируем непроверенное. */
export async function commitSelfPatch(message: string): Promise<PatchOutcome> {
  const state = await loadState();
  if (!state) return { ok: false, message: "Открытой правки нет." };
  if (state.stage === "open" || state.lastVerify?.ok !== true) {
    return { ok: false, message: "Сначала проверка (компилятор + тесты) — непроверенное не фиксирую.", state };
  }
  // 🔴 Рельсы ПЕРЕПРОВЕРЯЕМ здесь, а не только в verify: между проверкой и фиксацией дерево могло
  // измениться, и `git add -A` утащил бы в коммит правку ограничителей под отчёт «всё зелено».
  const changedNow = await patchChangedFiles(state);
  const hitsNow = protectedHits(changedNow);
  if (hitsNow.length > 0) {
    return { ok: false, message: `Не фиксирую: правка трогает мои ограничители (${hitsNow.join(", ")}). Это делает владелец руками.`, state };
  }
  // И сверяем ОТПЕЧАТОК: зелёная проверка относилась к конкретному содержимому файлов.
  const fingerprintNow = await treeFingerprint(state);
  if (state.verifiedFingerprint && fingerprintNow !== state.verifiedFingerprint) {
    const reset: SelfPatchState = { ...state, stage: "open", verifiedFingerprint: undefined };
    await saveState(reset);
    return { ok: false, message: "После проверки код изменился — зелёный прогон к нему больше не относится. Нужен повторный verify.", state: reset };
  }
  const commit = await git(["commit", "-m", String(message ?? state.title).slice(0, 500)]);
  if (!commit.ok && !/nothing to commit/i.test(commit.out)) return { ok: false, message: `Коммит не прошёл: ${commit.out.slice(0, 300)}`, state };
  const next: SelfPatchState = { ...state, stage: "committed" };
  await saveState(next);
  return { ok: true, message: `Зафиксировал в ветке ${state.branch}. Применять к рабочей ветке (${state.baseBranch})? Это требует вашего согласия.`, state: next };
}

/**
 * Применить правку к рабочей ветке. Вызывать ТОЛЬКО после подтверждения владельца (§14) — здесь
 * подтверждение не спрашивается, потому что канал подтверждения живёт в слое инструментов.
 */
export async function applySelfPatch(): Promise<PatchOutcome> {
  const state = await loadState();
  if (!state) return { ok: false, message: "Открытой правки нет." };
  if (state.stage !== "committed") return { ok: false, message: "Правка ещё не зафиксирована — применять нечего.", state };
  // Незакоммиченные изменения `git checkout` перенёс бы на рабочую ветку ВМЕСТЕ с переключением —
  // то есть в рабочий код уехало бы то, чего не было ни в проверке, ни в подтверждении владельца.
  const before = await repoStatus();
  if (before.dirty) {
    return {
      ok: false,
      message: `В ветке ${state.branch} остались незафиксированные изменения (${before.changedFiles.slice(0, 5).join(", ")}). Проверь и зафиксируй их — непроверенное в рабочую ветку не переношу.`,
      state,
    };
  }
  // 🔴 Состояние цикла лежит в файле, а файл — на диске владельца: доверять одному лишь `stage`
  // нельзя (подделав его, можно было бы применить НЕпроверенное). Перед применением сверяем то, что
  // реально уедет в рабочую ветку: список изменений против рельсов и отпечаток проверенного дерева.
  const hitsNow = protectedHits(await patchChangedFiles(state));
  if (hitsNow.length > 0) {
    return { ok: false, message: `Не применяю: в ветке тронуты мои ограничители (${hitsNow.join(", ")}).`, state };
  }
  const fingerprintNow = await treeFingerprint(state);
  if (state.verifiedFingerprint && fingerprintNow !== state.verifiedFingerprint) {
    return { ok: false, message: "Содержимое ветки отличается от проверенного — применять не буду, нужен повторный verify.", state };
  }
  if (!state.verifiedFingerprint) {
    return { ok: false, message: "У этой правки нет отметки о пройденной проверке — применять нечего (сделай verify заново).", state };
  }
  const back = await git(["checkout", state.baseBranch]);
  if (!back.ok) return { ok: false, message: `Не смог вернуться на ${state.baseBranch}: ${back.out.slice(0, 300)}`, state };
  const merged = await git(["merge", "--ff-only", state.branch]);
  if (!merged.ok) {
    await git(["checkout", state.branch]); // остаёмся там, где работа, чтобы её не потерять
    return { ok: false, message: `Слить не удалось (${merged.out.slice(0, 200)}). Работа цела в ветке ${state.branch}.`, state };
  }
  await saveState(undefined);
  return { ok: true, message: `Применил к ${state.baseBranch}. Чтобы изменения заработали, меня нужно перезапустить.` };
}

/**
 * Закрыть цикл без применения. Незакоммиченное теряется, поэтому требует явного `discard` —
 * молча стирать сделанную работу нельзя.
 */
export async function abortSelfPatch(discard = false): Promise<PatchOutcome> {
  const state = await loadState();
  if (!state) return { ok: false, message: "Открытой правки нет." };
  const status = await repoStatus();
  if (status.dirty && !discard) {
    return { ok: false, message: `В ветке ${state.branch} есть незафиксированные изменения. Если их точно выбрасываем — повтори с discard.`, state };
  }
  if (status.dirty) await git(["checkout", "--", "."]);
  const back = await git(["checkout", state.baseBranch]);
  if (!back.ok) return { ok: false, message: `Не смог вернуться на ${state.baseBranch}: ${back.out.slice(0, 300)}`, state };
  await saveState(undefined);
  const kept = state.stage === "committed" ? ` Сделанное осталось в ветке ${state.branch}.` : "";
  return { ok: true, message: `Закрыл правку «${state.title}», вернулся на ${state.baseBranch}.${kept}` };
}
