/**
 * W2 (П3, решения №2–3): ЧТО и ГДЕ коммитит GUI-действие — по ЗАПРОСУ модели, до исполнения (сервер выдаёт гранты
 * заранее). Подписи — только `actCommitIntent`/`commitSignature` из shared (их же считает клиентский рубеж по факту),
 * процесс — `canonicalProcess` («телега» → telegram, «1С» → 1cv8). Не распознано → вопроса заранее нет: клиент спросит
 * через `needsApproval` с РЕАЛЬНЫМ процессом (грантов «по категории» нет).
 *
 * Сервер не знает роль элемента по тексту запроса («Катя» — чат-ListItem или кнопка?): в allowlist-категориях
 * (мессенджер/банк/ЭДО) элемент без известной роли заранее судится только по глаголам коммита — иначе вопрос на
 * каждый переход в чат. Остальное рассудит клиент по найденному элементу и вернёт needsApproval.
 */
import { COMMIT_WORDS_RE, type CommitIntent, type GuiCategory, actCommitIntent, canonicalProcess, guiProcessCategory } from "@jarvis/shared";
import { cleanUntrusted } from "./approval-text.js";
import type { HandleInfo } from "./gate-memory.js";

/** Передний план из живого снимка client.system: «На переднем плане: <process> «title»» (sensors/system-snapshot.ts). */
export function parseForeground(systemContext: string): { process: string | null; title?: string } {
  const m = /На переднем плане:\s*([^\s«(·]+)(?:\s*«([^»]*)»)?/u.exec(systemContext);
  return m ? { process: m[1]!, ...(m[2] ? { title: m[2] } : {}) } : { process: null };
}

export interface GuiWhere {
  /** Канонический процесс гранта; null — не распознан (заранее не судим). */
  process: string | null;
  category: GuiCategory | null;
  human: string;
  /** Как назвать место владельцу: строка модели (`app`) или имя процесса переднего плана. */
  display: string;
  /** Заголовок окна (только если цель — передний план): по нему гейт браузера выбирает вкладку. */
  title?: string;
}

/** Где исполнится действие: `app` act (act сам фокусирует это окно ПОСЛЕ гейта) или передний план. */
export function resolveWhere(app: string | null, systemContext: string): GuiWhere {
  const fg = parseForeground(systemContext);
  const process = app ? canonicalProcess(app) : canonicalProcess(fg.process);
  const cat = process ? guiProcessCategory(process) : null;
  const sameAsFg = !app || (process !== null && process === canonicalProcess(fg.process));
  return {
    process,
    category: cat?.category ?? null,
    human: cat?.human ?? "",
    display: cleanUntrusted(app ?? fg.process ?? "", 60),
    ...(sameAsFg && fg.title ? { title: fg.title } : {}),
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const ALLOWLIST_CATEGORIES: ReadonlySet<string> = new Set(["messenger", "bank", "edo"]);

/** Имя цели запроса (строка act, {text|name}, handle → память) — для текста вопроса. */
export function targetName(input: Record<string, unknown>, mem?: HandleInfo): string {
  const t = input.target;
  if (typeof t === "string") return t.trim();
  const o = t && typeof t === "object" ? (t as Record<string, unknown>) : {};
  return str(o.text) || str(o.name) || mem?.label || "";
}

/**
 * Намерения-коммиты запроса `tool` (act/input_key/input_type/input_click/ui_invoke) в месте `where`. `mem` — запись
 * памяти по handle цели (имя и роль из снимка).
 */
export function serverIntents(tool: string, input: Record<string, unknown>, where: GuiWhere, mem?: HandleInfo): CommitIntent[] {
  if (!where.category) return [];
  if (tool === "input_click" && input.button === "right") return []; // правый клик открывает меню — клиент тоже не судит
  const t = input.target;
  const tobj = t && typeof t === "object" ? (t as Record<string, unknown>) : undefined;
  const role = str(tobj?.role) || mem?.role || "";
  const name = targetName(input, mem);
  // Роль из снимка — в цель: allowlist безопасных целей (ListItem «Катя», поле) судит по ней.
  const intentInput = tobj && role ? { ...input, target: { ...tobj, role } } : input;
  let intents = actCommitIntent(intentInput, { category: where.category, label: mem?.label, tool });
  const roleUnknown = !role && ALLOWLIST_CATEGORIES.has(where.category);
  if (roleUnknown && !COMMIT_WORDS_RE.test(name)) intents = intents.filter((i) => !i.signature.startsWith("click:"));
  // Почта: перевод строки в тексте письма — новый абзац, не отправка (CLAUDE.md «почта — нет»); явный enter — Enter.
  const typing = tool === "input_type" || (tool === "act" && str(input.do) === "type");
  if (typing && where.human === "почта") {
    const explicit = input.enter === true ? 1 : 0;
    intents = intents.flatMap((i) => (i.signature !== "key:enter" ? [i] : explicit ? [{ ...i, count: explicit }] : []));
  }
  return intents;
}

/** Человеко-описание подписи для вопроса владельцу (подпись строит shared: имя уже сложено и ≤ 60). */
export function describeSignature(signature: string, category: GuiCategory | null | string, display?: string): string {
  if (signature === "key:enter") return category === "messenger" ? "Enter — отправка сообщения" : "Enter — подтверждение/отправка";
  if (signature.startsWith("key:")) return `клавиши ${cleanUntrusted(signature.slice(4), 30)}`;
  // Подпись от клиента несёт имя элемента С ЭКРАНА (M11): в текст — только очищенным (без кавычек и угловых скобок).
  if (signature.startsWith("click:?")) return `нажатие безымянного элемента (${cleanUntrusted(signature.slice(7), 30)})`;
  return `клик «${cleanUntrusted(display, 60) || cleanUntrusted(signature.slice(6), 60)}»`;
}
