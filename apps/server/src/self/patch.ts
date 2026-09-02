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
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  // Здесь стоит САМ §14-гейт: перед fs_delete/system_power и мутирующим MCP-инструментом dispatch
  // зовёт ctx.confirm, а без канала подтверждения честно отказывает (fail-closed). Правка одной
  // строки здесь снимает вопрос владельцу разом со ВСЕХ необратимых действий — рельс, а не код.
  "apps/server/src/brain/tools/dispatch.ts",
  "apps/server/src/brain/messaging/outbound.ts",
  "apps/server/src/brain/orders/order-guard.ts",
  "apps/server/src/brain/tools/dispatch-util.ts",
  // Рельсы §4 у code.run: самозащита (не убивать свои процессы), питание только через system_power,
  // необратимая потеря данных → confirm. Песочницы у code.run нет ОСОЗНАННО, поэтому этот линт —
  // единственный ограничитель на пути произвольного кода; снявшая его правка снимает всё сразу.
  "apps/server/src/brain/code-guard.ts",
  // Вырезание секретов из env дочернего процесса (*KEY/SECRET/TOKEN/PASSWORD/CREDENTIAL). Убери
  // фильтр — и любой скрипт code_run получает ключи владельца целиком, тихо и без следов в диффе
  // логики. Ограничитель живёт на клиенте, но снять его можно серверной самоправкой — значит в список.
  "apps/client/main/actuators/code-runner.ts",
  // Саморасширение tool_create: самописный инструмент исполняется через тот же гардированный
  // code.run (lintCode при создании и запуске). Правка здесь даёт способ завести инструмент В ОБХОД
  // предохранителей — то есть снять рельсы, не трогая сами рельсы.
  "apps/server/src/brain/tools/dynamic.ts",
  // Торговый контур: единственное место, где Джарвис ходит в брокера токеном владельца. Контур
  // read-only ПО КОДУ, а не по политике — автономная правка, добавляющая ордерный запрос, двигала бы
  // чужие деньги без §14. Деньги обратно не откатываются, поэтому запрет здесь превентивный.
  "apps/server/src/brain/trading/tinkoff.ts",
  "apps/server/src/brain/agent/error-voice.ts",
  "apps/server/src/gateway/bind.ts",
  "apps/client/main/actuators/self-guard.ts",
  // Границы чтения СВОЕГО кода: ослабь их — и следующая правка прочитает data/ владельца и секреты
  // (клиентский self-guard закрывает fs_*-путь, а этот файл — серверный канал; контроль-2).
  "apps/server/src/self/repo.ts",
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
   * 🔴 SHA КОММИТА, который реально проверялся (контроль-2 волны I). Проверка идёт не в живом дереве,
   * а в одноразовом git-worktree на этом коммите — поэтому «что проверено» выражается одним sha, и
   * любая последующая правка (в том числе снятие ограничителей) сдвигает HEAD и обнуляет зелёный
   * статус. Прежний отпечаток индекса этого не давал: `git add -A` внутри сверки сам менял состояние.
   */
  verifiedCommit?: string;
}

/**
 * Вызов git. `out` удобен для сообщений (обрезан), `raw` — для РАЗБОРА.
 * 🔴 Разница принципиальна (поймано ЖИВЫМ прогоном цикла, тесты этого не видели): в
 * `git status --porcelain` первые два символа — коды состояния, и у обычной незастейдженной правки
 * первый из них ПРОБЕЛ (« M путь»). Общий `trim()` съедал его у ПЕРВОЙ строки, разбор сдвигался на
 * символ, путь приезжал как «pps/server/…» — и гард ограничителей НЕ УЗНАВАЛ защищённый файл, если
 * тот шёл в списке первым. То есть правку killswitch можно было пронести мимо рельсов.
 */
function git(args: readonly string[]): Promise<{ ok: boolean; out: string; raw: string }> {
  return new Promise((resolvePromise) => {
    execFile("git", [...args], { cwd: selfRepoRoot(), timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const raw = `${stdout ?? ""}${stderr ?? ""}`;
      resolvePromise({ ok: !error, out: raw.trim(), raw });
    });
  });
}

/**
 * Разбор `git status --porcelain` (ЧИСТАЯ функция — тестируется без git). Формат: два символа кода,
 * пробел, путь; переименование — «было -> стало». Кавычки вокруг пути (не-ASCII при core.quotepath)
 * снимаем: иначе защищённый файл с кириллицей в пути прошёл бы мимо гарда.
 */
export function parsePorcelain(raw: string, opts: { onlyDeleted?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    if (line.length < 4) continue;
    if (opts.onlyDeleted && !line.slice(0, 2).includes("D")) continue;
    // 🔴 Переименование даёт ОБЕ стороны (контроль-2): раньше брался только новый путь, и файл-
    // ограничитель, УВЕДЁННЫЙ из-под защищённого пути (`git mv self-guard.ts guard.ts`), исчезал
    // из проверки — гард видел лишь новое имя и рапортовал «ничего не трогали».
    for (const side of line.slice(3).split(" -> ")) {
      const cleaned = side.trim().replace(/^"(.*)"$/, "$1");
      if (cleaned) out.push(cleaned);
    }
  }
  return out;
}

/** Строка `git diff --name-status`: статус + путь (у переименования — обе стороны отдельно). */
export function parseNameStatus(raw: string): Array<{ status: string; path: string }> {
  const out: Array<{ status: string; path: string }> = [];
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t").filter((p) => p.trim());
    const status = (parts[0] ?? "").trim();
    if (!status || parts.length < 2) continue;
    for (const p of parts.slice(1)) out.push({ status, path: p.trim() });
  }
  return out;
}

/** Тестовый ли это файл (по имени) — правка не должна покупать «зелено» удалением тестов. */
export function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path);
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

/** Свободное имя ветки: к занятому добавляем номер (-2, -3…), пока не найдём незанятое. */
async function freeBranchName(base: string): Promise<string> {
  for (let i = 1; i <= 20; i += 1) {
    const name = i === 1 ? base : `${base}-${i}`;
    const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    if (!exists.ok || !exists.out.trim()) return name;
  }
  return `${base}-${Math.floor(Date.now() / 1000)}`;
}

export interface RepoStatus {
  branch: string;
  dirty: boolean;
  changedFiles: string[];
}

export async function repoStatus(): Promise<RepoStatus> {
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).out.trim();
  const changedFiles = parsePorcelain((await git(["status", "--porcelain"])).raw);
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
  // Ветка от прошлой правки на ту же тему могла остаться (abort её СОХРАНЯЕТ — работу не теряем),
  // и повторный заход упирался бы в сырое «branch already exists». Подбираем свободное имя.
  const branch = await freeBranchName(branchNameFor(title, today));
  const created = await git(["checkout", "-b", branch]);
  if (!created.ok) return { ok: false, message: `Не смог создать ветку ${branch}: ${created.out.slice(0, 300)}` };
  const state: SelfPatchState = { branch, baseBranch: status.branch, title: String(title ?? "").slice(0, 200), startedAt: new Date().toISOString(), stage: "open" };
  await saveState(state);
  return { ok: true, message: `Открыл правку «${state.title}» в ветке ${branch} (от ${status.branch}).`, state };
}

/** SHA текущего коммита ветки правки. */
async function headSha(): Promise<string> {
  return (await git(["rev-parse", "HEAD"])).out.trim();
}

/** Сообщение промежуточного коммита правки (переписывается осмысленным на шаге commit). */
const WIP_MESSAGE = "wip: правка на проверке";

/**
 * Зафиксировать текущее состояние правки коммитом в СВОЕЙ ветке — это делает «что проверяем»
 * однозначным (один sha) и позволяет проверять правку в отдельном рабочем дереве, а не в живом.
 * Повторный вызов переписывает свой же промежуточный коммит, чтобы история не распухала.
 */
async function stageWork(): Promise<{ ok: boolean; out: string }> {
  await git(["add", "-A"]);
  const last = (await git(["log", "-1", "--pretty=%s"])).out.trim();
  const args = last === WIP_MESSAGE ? ["commit", "--amend", "-m", WIP_MESSAGE] : ["commit", "-m", WIP_MESSAGE];
  const r = await git(args);
  if (!r.ok && /nothing to commit/i.test(r.out)) return { ok: true, out: r.out };
  return r;
}

/** Что изменено в текущем цикле (рабочее дерево + уже сделанные коммиты ветки). */
export async function patchChangedFiles(state: SelfPatchState): Promise<string[]> {
  const working = (await repoStatus()).changedFiles;
  const committed = parseNameStatus((await git(["diff", "--name-status", `${state.baseBranch}...HEAD`])).raw).map((c) => c.path);
  return [...new Set([...working, ...committed])];
}

/**
 * Тесты, УДАЛЁННЫЕ правкой. 🔴 Контроль-2 (HIGH): «проверки зелёные» покупалось удалением тестов —
 * файлы тестов не были ограничителями, а прогон ничего не сравнивал с базовой веткой. Владельцу при
 * этом сообщали «зелено», то есть утверждали проверенность там, где проверка была выброшена.
 */
export async function removedTests(state: SelfPatchState): Promise<string[]> {
  const committed = parseNameStatus((await git(["diff", "--name-status", `${state.baseBranch}...HEAD`])).raw)
    .filter((c) => c.status.startsWith("D"))
    .map((c) => c.path);
  const working = parsePorcelain((await git(["status", "--porcelain"])).raw, { onlyDeleted: true });
  return [...new Set([...committed, ...working])].filter(isTestFile);
}

/**
 * Проверить правку: рельсы + компилятор + тесты.
 *
 * 🔴 Прогон идёт в ОДНОРАЗОВОМ рабочем дереве (контроль-2 волны I, HIGH): `vitest` ИСПОЛНЯЕТ любой
 * добавленный правкой `*.test.ts`, а раньше делал это прямо в живом чекауте — то есть запись файла
 * превращалась в выполнение кода рядом с боевыми `data/` (согласия §14, латч аварийного стопа),
 * минуя рельсы записи клиента. Теперь проверяемый коммит выкладывается во временный worktree, и
 * тест-файл видит только копию репозитория: ни личных данных владельца, ни рабочего дерева.
 */
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
  // Покрытие не должно уменьшаться незаметно: удалённый тест делает «зелено» дешёвым (контроль-2).
  const removed = await removedTests(state);
  if (removed.length > 0) {
    return {
      ok: false,
      message: `Правка УДАЛЯЕТ тесты (${removed.slice(0, 5).join(", ")}). Зелёный прогон без них ничего не доказывает — верни их или пусть владелец решает сам.`,
      state,
    };
  }

  const staged = await stageWork();
  if (!staged.ok) return { ok: false, message: `Не смог зафиксировать правку для проверки: ${staged.out.slice(0, 200)}`, state };
  const sha = await headSha();

  const dir = join(tmpdir(), `jarvis-verify-${sha.slice(0, 8)}-${process.pid}`);
  const added = await git(["worktree", "add", "--detach", dir, sha]);
  if (!added.ok) return { ok: false, message: `Не смог подготовить изолированное дерево для проверки: ${added.out.slice(0, 200)}`, state };
  let verify: VerifyOutcome;
  try {
    verify = await verifyChanges(changed, dir);
  } finally {
    await git(["worktree", "remove", "--force", dir]);
  }

  const next: SelfPatchState = {
    ...state,
    stage: verify.ok ? "verified" : "open",
    lastVerify: { ok: verify.ok, summary: verify.summary, at: new Date().toISOString() },
    ...(verify.ok ? { verifiedCommit: sha } : { verifiedCommit: undefined }),
  };
  await saveState(next);
  return { ok: verify.ok, message: verify.ok ? `Проверил: ${verify.summary} Изменено файлов: ${changed.length}.` : `Не готово. ${verify.summary}`, state: next, verify };
}

/**
 * Дать правке осмысленное имя. Проверка уже зафиксировала её промежуточным коммитом, поэтому здесь
 * мы лишь переписываем сообщение — и проверяем, что с момента зелёного прогона ничего не дописано.
 */
export async function commitSelfPatch(message: string): Promise<PatchOutcome> {
  const state = await loadState();
  if (!state) return { ok: false, message: "Открытой правки нет." };
  if (state.stage === "open" || state.lastVerify?.ok !== true || !state.verifiedCommit) {
    return { ok: false, message: "Сначала проверка (компилятор + тесты) — непроверенное не фиксирую.", state };
  }
  // Дописали что-то после проверки → зелёный прогон к этому уже не относится.
  const dirty = (await repoStatus()).dirty;
  const head = await headSha();
  if (dirty || head !== state.verifiedCommit) {
    const reset: SelfPatchState = { ...state, stage: "open", verifiedCommit: undefined };
    await saveState(reset);
    return { ok: false, message: "После проверки код изменился — зелёный прогон к нему больше не относится. Нужен повторный verify.", state: reset };
  }
  const hitsNow = protectedHits(await patchChangedFiles(state));
  if (hitsNow.length > 0) {
    return { ok: false, message: `Не фиксирую: правка трогает мои ограничители (${hitsNow.join(", ")}). Это делает владелец руками.`, state };
  }
  const amend = await git(["commit", "--amend", "-m", String(message ?? state.title).slice(0, 500)]);
  if (!amend.ok) return { ok: false, message: `Коммит не прошёл: ${amend.out.slice(0, 300)}`, state };
  const next: SelfPatchState = { ...state, stage: "committed", verifiedCommit: await headSha() };
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
  if (!state.verifiedCommit) {
    return { ok: false, message: "У этой правки нет отметки о пройденной проверке — применять нечего (сделай verify заново).", state };
  }
  if ((await headSha()) !== state.verifiedCommit) {
    return { ok: false, message: "Содержимое ветки отличается от проверенного — применять не буду, нужен повторный verify.", state };
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
  // 🔴 Контроль-2 (HIGH): `git checkout -- .` восстанавливает из ИНДЕКСА, а проверка успела сделать
  // `git add -A` — поэтому «выброшенная» правка оставалась в индексе и переезжала на рабочую ветку
  // вместе с checkout, минуя подтверждение владельца. Заявляли выбрасывание — делали перенос.
  if (status.dirty) {
    await git(["reset", "--hard", "HEAD"]);
    await git(["clean", "-fd"]);
    const after = await repoStatus();
    if (after.dirty) {
      return { ok: false, message: `Не смог выбросить изменения (${after.changedFiles.slice(0, 3).join(", ")}) — с ветки не ухожу, чтобы ничего не перенести на рабочую.`, state };
    }
  }
  const back = await git(["checkout", state.baseBranch]);
  if (!back.ok) return { ok: false, message: `Не смог вернуться на ${state.baseBranch}: ${back.out.slice(0, 300)}`, state };
  await saveState(undefined);
  const kept = state.stage === "committed" ? ` Сделанное осталось в ветке ${state.branch}.` : "";
  return { ok: true, message: `Закрыл правку «${state.title}», вернулся на ${state.baseBranch}.${kept}` };
}
