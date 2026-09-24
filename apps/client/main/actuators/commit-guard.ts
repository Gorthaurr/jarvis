/**
 * W0 (2026-09-09): КЛИЕНТСКИЙ РУБЕЖ §14 для путей, минующих серверный `dispatchTool`.
 *
 * Серверный `commit-gate` (подтверждение владельца перед необратимым Enter в мессенджере/банке/1С)
 * стоит в ОДНОЙ точке входа из трёх. Две другие — SDK-мост (`act-bridge`: python-скрипт `code_run`
 * зовёт `jarvis.key("enter")`) и реплей навыка (`skill-runner/client-actuator`) — идут в актуаторы
 * напрямую. Обе питаются влияемым текстом (страница/навык), то есть это ровно вектор prompt-инъекции,
 * против которого гейт и вводился.
 *
 * Клиент подтверждение спросить не может (нет канала к владельцу) → он ОТКАЗЫВАЕТ fail-closed:
 * коммит в рискованном процессе доступен только штатным инструментом `input_key` через сервер, где
 * встанет вопрос владельцу. Честная ошибка называет процесс и путь.
 *
 * Предел (осознанный, как у серверного гейта): судим только клавишу-коммит по процессу на переднем
 * плане; клик по координатам и печать текста не судятся. Передний план неизвестен (сайдкар лёг) →
 * пропускаем (fail-open на неизвестности — та же политика, что у `parseForegroundProcess` на сервере).
 */
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { COMMIT_WORDS_RE, createLogger, isCommitKeyCombo, riskyProcessCategory } from "@jarvis/shared";
import { listWindows } from "./windows.js";

const log = createLogger("actuator:commit-guard");

export interface CommitDenial {
  /** Процесс на переднем плане, из-за которого отказ. */
  process: string;
  human: string;
  message: string;
}

/**
 * ЧИСТАЯ политика: нужно ли отказать команде `cmd`, если на переднем плане процесс `foreground`.
 * `via` — откуда пришла команда (для текста ошибки).
 */
export function assessClientCommit(cmd: ActionCommand, foregroundNow: string | null, via: "bridge" | "replay"): CommitDenial | null {
  // Ревью 2026-09-24 (H-S1): act с app САМ фокусирует это окно — программа коммита та, что в app, а не текущий передний план.
  const foreground = cmd.kind === "gui.act" && cmd.app?.trim() ? cmd.app.trim() : foregroundNow;
  if (!foreground) return null;
  const what = commitOf(cmd);
  if (!what) return null;
  const risk = riskyProcessCategory(foreground);
  if (!risk) return null;
  const path = via === "bridge" ? "SDK-мост (jarvis.key из code_run)" : "реплей навыка";
  return {
    process: foreground,
    human: risk.human,
    message:
      `§14: ${what} в программе ${foreground} (${risk.human}) — необратимая отправка. ` +
      `${path} её не делает: используй инструмент input_key/act (сервер спросит подтверждение владельца) ` +
      `или заверши шаг без отправки.`,
  };
}

/**
 * Что в команде похоже на коммит: клавиша-коммит (input.key / act do:key) или клик по подписи-коммиту
 * (act по тексту «Отправить»/«Оплатить» — W4). Остальное (печать, set, toggle) само ничего не отправляет.
 */
function commitOf(cmd: ActionCommand): string | null {
  if (cmd.kind === "input.key") {
    if (cmd.mode === "up") return null; // отпускание клавиши ничего не коммитит
    return isCommitKeyCombo(cmd.combo) ? `«${cmd.combo}»` : null;
  }
  if (cmd.kind !== "gui.act") return null;
  const verb = cmd.do ?? "click";
  if (verb === "key") return cmd.combo && isCommitKeyCombo(cmd.combo) ? `«${cmd.combo}»` : null;
  if (verb !== "click" && verb !== "double") return null;
  const t = cmd.target;
  const text = typeof t === "string" ? t : t && typeof t === "object" ? String(t.text ?? "") : "";
  return text && COMMIT_WORDS_RE.test(text) ? `клик «${text.trim().slice(0, 60)}»` : null;
}

/** Процесс окна на переднем плане (null, если сайдкар недоступен или окно не найдено). */
export async function foregroundProcess(): Promise<string | null> {
  try {
    const wins = await listWindows();
    const fg = wins.find((w) => w.foreground);
    return fg?.process ?? null;
  } catch (e) {
    log.debug("передний план неизвестен (сайдкар?) — гейт коммита пропускает", e instanceof Error ? e.message : String(e));
    return null;
  }
}

export type DispatchLike = (commandId: string, cmd: ActionCommand) => Promise<ActionResult>;

/**
 * Обёртка dispatch для SDK-моста: рискованный коммит → честный отказ БЕЗ исполнения.
 * `fg` инжектируется (в бою — foregroundProcess, в тестах — заглушка).
 */
export function guardedDispatch(dispatch: DispatchLike, fg: () => Promise<string | null> = foregroundProcess): DispatchLike {
  return async (commandId, cmd) => {
    if (cmd.kind === "input.key" || cmd.kind === "gui.act") {
      const denial = assessClientCommit(cmd, await fg(), "bridge");
      if (denial) {
        log.warn("§14 гейт коммита на мосту SDK: отказ", { kind: cmd.kind, process: denial.process });
        return { commandId, ok: false, error: { code: "denied", message: denial.message }, durationMs: 0 };
      }
    }
    return dispatch(commandId, cmd);
  };
}

/** Для реплея навыка: бросает Error с честным текстом, если шаг — рискованный коммит. */
export async function assertReplayCommitAllowed(combo: string, mode: "press" | "down" | "up" | undefined, fg: () => Promise<string | null> = foregroundProcess): Promise<void> {
  const cmd: ActionCommand = { kind: "input.key", combo, ...(mode ? { mode } : {}) };
  const denial = assessClientCommit(cmd, await fg(), "replay");
  if (denial) {
    log.warn("§14 гейт коммита в реплее навыка: отказ", { combo, process: denial.process });
    throw new Error(denial.message);
  }
}
