/**
 * Рельсы самосохранности клиента над ВИРТУАЛЬНЫМИ путями. Предикаты и тексты отказов — НАСТОЯЩИЕ (self-guard.ts клиента,
 * импорт как есть): секреты/.env/ключи, node_modules, конфиги прав агента. Пути в них уходят в виде C:/… (прямые слэши: так
 * basename читается и на Linux-стенде), а в текст отказа возвращаются в виде C:\… — как их видит модель у владельца.
 * assertTreeWritable — порт `assertTreeWritable` из fs.ts над виртуальным поддеревом (без «предка запущенного бинаря»:
 * в виртуальном ПК Джарвиса нет).
 */
import { assertReadable, assertWritable, isProtectedSelfPathFast } from "../../../apps/client/main/actuators/self-guard.js";
import type { DesktopCore } from "./core.js";
import { type VIndex, buildIndex, lower, tryStat, winPath } from "./vfs.js";

/** Тот же бюджет, что у клиента (TREE_GUARD_BUDGET): исчерпание = отказ (fail-closed), а не «чисто». */
export const TREE_GUARD_BUDGET = 200_000;

function reword(e: unknown, abs: string): never {
  if (e instanceof Error) e.message = e.message.split(abs).join(winPath(abs));
  throw e;
}

export function guardRead(abs: string): void {
  try {
    assertReadable(abs);
  } catch (e) {
    reword(e, abs);
  }
}

export function guardWrite(abs: string): void {
  try {
    assertWritable(abs);
  } catch (e) {
    reword(e, abs);
  }
}

function firstProtected(idx: VIndex, dir: string, budget: { n: number; exhausted: boolean }): string | null {
  if (budget.n <= 0) {
    budget.exhausted = true;
    return null;
  }
  const kids = idx.kids.get(lower(dir)) ?? [];
  for (const k of kids) {
    budget.n -= 1;
    if (isProtectedSelfPathFast(k.p)) return k.p;
  }
  for (const k of kids) {
    if (budget.n <= 0) {
      budget.exhausted = true;
      return null;
    }
    if (k.kind === "dir") {
      const deeper = firstProtected(idx, k.p, budget);
      if (deeper || budget.exhausted) return deeper;
    }
  }
  return null;
}

/** Рекурсивное delete / любой move: сверяем не только сам путь, но и всё поддерево каталога. */
export function assertTreeWritable(core: DesktopCore, abs: string, budgetN: number = TREE_GUARD_BUDGET): void {
  guardWrite(abs);
  const idx = buildIndex(core);
  const e = tryStat(core, abs, idx);
  if (!e || e.kind !== "dir") return; // нет пути — пусть операция сама отдаст честную ошибку
  const budget = { n: budgetN, exhausted: false };
  const hit = firstProtected(idx, e.p, budget);
  if (hit) {
    throw new Error(`защита самосохранности (§): каталог «${winPath(abs)}» содержит защищённое («${winPath(hit)}») — рекурсивное удаление/перемещение отклонено. Удаляй/двигай точечно.`);
  }
  if (budget.exhausted) {
    throw new Error(`защита самосохранности (§): каталог «${winPath(abs)}» слишком большой для полной проверки поддерева (>${TREE_GUARD_BUDGET} записей) — рекурсивное удаление/перемещение отклонено (fail-closed). Удаляй/двигай точечно.`);
  }
}
