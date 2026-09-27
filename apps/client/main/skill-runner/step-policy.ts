/**
 * W2 П1 (безопасность №5): политика ПОВТОРОВ реплея навыка и отказ рубежа §14 в нём.
 *
 * Раньше раннер глотал любую ошибку шага и повторял его (по умолчанию дважды): отказ рубежа «нужно «да» владельца»
 * превращался в три попытки, а коммит-шаг с проваленным expect (invoke «Отправить» УШЁЛ, признак не наступил)
 * отправлялся второй раз. Теперь:
 *  - отказ рубежа (`denied`: своё окно, §0, §14) — стоп без повтора; наверх едут данные вопроса (needsApproval),
 *    номер шага и «часть ушла» — сервер спросит владельца и продолжит со шага k (`steps.slice(k)`);
 *  - шаг с намерением «коммит или неизвестно» получает retries = 0 (повтор ушедшего = дубль отправки).
 * Категория процесса шага заранее неизвестна — берём строжайший allowlist (мессенджер).
 */
import type { SkillStep } from "@jarvis/protocol";
import { elementCommit, keyClass, textIntents } from "@jarvis/shared";
import { actionErrorOf } from "../actuators/action-error.js";

/** Шаги без побочного эффекта в чужой программе или идемпотентные. */
const SAFE_ACTIONS: ReadonlySet<string> = new Set(["app.launch", "app.focus", "browser.open", "wait", "ground", "verify", "ui.ground"]);
const SAFE_PATTERNS: ReadonlySet<string> = new Set(["setValue", "expand", "scroll"]);

/** Может ли шаг оказаться коммитом (или это не узнать заранее). */
export function stepMayCommit(step: SkillStep): boolean {
  if (SAFE_ACTIONS.has(step.action)) return false;
  const p = step.params ?? {};
  const t = step.target;
  const named = t && t.by === "role" ? { role: t.role, name: t.name } : null;
  switch (step.action) {
    case "input.type":
      return textIntents(p.text).newlines > 0;
    case "input.key":
      return p.mode !== "up" && keyClass(String(p.combo ?? "")) !== "safe";
    case "input.click":
      return p.button === "right" ? false : !named || elementCommit(named, "messenger", "click") !== null;
    case "ui.invoke": {
      const pattern = String(p.pattern ?? "invoke");
      if (SAFE_PATTERNS.has(pattern)) return false;
      return !named || elementCommit(named, "messenger", pattern === "invoke" ? "click" : pattern) !== null;
    }
    case "input.mouse":
      return p.op === "down" || p.op === "drag";
    default:
      return true;
  }
}

/** Повторов для шага: коммит/неизвестно — 0 (ретрай ушедшего = дубль), иначе из контента с капом 5. */
export function stepRetries(step: SkillStep): number {
  return stepMayCommit(step) ? 0 : Math.max(0, Math.min(5, step.retries ?? 2));
}

/** Отказ рубежа инжекции: не ретраится; данные вопроса и «часть ушла» — наверх. */
export function injectionDenial(e: unknown): { data?: unknown; injected: boolean } | null {
  const ae = actionErrorOf(e);
  return ae?.code === "denied" ? { ...(ae.data !== undefined ? { data: ae.data } : {}), injected: ae.injected } : null;
}
