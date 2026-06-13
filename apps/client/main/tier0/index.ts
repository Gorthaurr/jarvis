/**
 * tier0 — локальный детерминированный парсер команд (§3, §7).
 *
 * Самый дешёвый тир маршрутизации (стоимость $0, без сети): простые регексп-команды
 * исполняются на клиенте напрямую, не доходя до сервера/LLM. Если фраза не распознана —
 * tier0 возвращает null, и клиент уходит в обычный поток (dev.text -> сервер).
 *
 * Команды — это (ActionCommand | спец-действие). Спец-действия (громкость) на M0
 * исполняются локально через системные средства Windows.
 *
 * Список РАСШИРЯЕМ: добавляйте записи в TIER0_RULES.
 */
import type { ActionCommand } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import { spawn } from "node:child_process";

const log = createLogger("tier0");

/**
 * Результат разбора tier0.
 *  - command: абстрактная ActionCommand → исполняется штатным dispatch(actuators).
 *  - local:   локальное системное действие (громкость и т.п.), без актуатора протокола.
 */
export type Tier0Match =
  | { kind: "command"; command: ActionCommand; utterance: string }
  | { kind: "local"; run: () => Promise<void>; label: string; utterance: string };

interface Tier0Rule {
  /** Регексп распознавания (регистр игнорируется, нормализованный текст). */
  re: RegExp;
  /** Построить результат по группам совпадения. */
  build: (m: RegExpMatchArray) => Tier0Match["kind"] extends never ? never : Tier0MatchPartial;
}

/** То, что возвращает правило (без utterance — его добавит parse). */
type Tier0MatchPartial =
  | { kind: "command"; command: ActionCommand }
  | { kind: "local"; run: () => Promise<void>; label: string };

/** Нормализация ввода: трим, схлопывание пробелов, нижний регистр, убрать финальную пунктуацию. */
function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/u, "");
}

// ── локальные системные действия (Windows) ─────────────────────

/** Нажать виртуальную клавишу мультимедиа через PowerShell SendKeys (M0 fallback громкости). */
function sendMediaKey(key: "[char]173" | "[char]174" | "[char]175"): () => Promise<void> {
  // 173 = Mute, 174 = Volume Down, 175 = Volume Up (VK codes как символы для SendKeys-обёртки).
  return () =>
    new Promise<void>((resolve, reject) => {
      const ps = `(New-Object -ComObject WScript.Shell).SendKeys([char]${key.replace(/\D/g, "")})`;
      const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
        windowsHide: true,
        stdio: "ignore",
      });
      child.on("error", reject);
      child.on("exit", () => resolve());
    });
}

// ── таблица правил (расширяемая) ───────────────────────────────

const TIER0_RULES: Tier0Rule[] = [
  // Запуск приложений: "открой <app>", "запусти <app>", "открой браузер"
  {
    re: /^(?:открой|запусти|открыть|запустить|open|launch)\s+(.+)$/u,
    build: (m) => ({ kind: "command", command: { kind: "app.launch", app: (m[1] ?? "").trim() } }),
  },
  // Фокус: "переключись на <app>", "фокус на <app>"
  {
    re: /^(?:переключись на|фокус на|focus)\s+(.+)$/u,
    build: (m) => ({ kind: "command", command: { kind: "app.focus", app: (m[1] ?? "").trim() } }),
  },
  // Открыть сайт: "открой сайт <url>", "перейди на <url>"
  {
    re: /^(?:открой сайт|перейди на|открой ссылку|go to)\s+(\S+)$/u,
    build: (m) => ({ kind: "command", command: { kind: "browser.open", url: (m[1] ?? "").trim() } }),
  },
  // Громкость: "выключи звук" / "включи звук" (mute toggle)
  {
    re: /^(?:выключи звук|включи звук|mute|без звука|тихо)$/u,
    build: () => ({ kind: "local", run: sendMediaKey("[char]173"), label: "mute" }),
  },
  // Громкость громче / тише
  {
    re: /^(?:громче|сделай громче|volume up)$/u,
    build: () => ({ kind: "local", run: sendMediaKey("[char]175"), label: "volume_up" }),
  },
  {
    re: /^(?:тише|сделай тише|volume down)$/u,
    build: () => ({ kind: "local", run: sendMediaKey("[char]174"), label: "volume_down" }),
  },
];

/**
 * Разобрать фразу. Возвращает Tier0Match при совпадении, иначе null (уходим на сервер).
 */
export function parse(text: string): Tier0Match | null {
  const utterance = normalize(text);
  if (!utterance) return null;

  for (const rule of TIER0_RULES) {
    const m = utterance.match(rule.re);
    if (m) {
      const partial = rule.build(m) as Tier0MatchPartial;
      log.info(`tier0 совпадение: "${utterance}" -> ${partial.kind}`);
      return { ...partial, utterance } as Tier0Match;
    }
  }
  return null;
}
