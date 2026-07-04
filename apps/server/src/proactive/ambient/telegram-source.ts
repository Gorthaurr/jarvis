/**
 * Источник ambient #2: TELEGRAM-НЕПРОЧИТАННЫЕ (§проактив-всё, пример «Сэр, вам написал Герман»). Читает
 * непрочитанные чаты через расширение НЕИНВАЗИВНО — из УЖЕ открытой вкладки web.telegram.org, БЕЗ кражи
 * фокуса (ambient не должен дёргать пользователя каждые N сек). Нет вкладки → молчим (пользователь и так
 * видит уведомления Telegram). Дёшево: чистый DOM-снимок, без LLM. Заглушённые чаты — ниже порога.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import type { AmbientSignal, AmbientSource } from "./signal.js";

const log: Logger = createLogger("ambient:telegram");

/** Один непрочитанный чат из расширения. */
export interface UnreadChat {
  title: string;
  count: number;
  preview?: string;
  muted?: boolean;
  peerId?: string;
}
/** Ответ расширения на telegram.unread. */
export interface UnreadResult {
  ok?: boolean;
  unread?: UnreadChat[];
  noTab?: boolean;
  error?: string;
}
/** Минимальный контракт ридера (ExtensionBridge реализует; в тестах — мок). */
export interface TelegramUnreadReader {
  telegramUnread(): Promise<unknown>;
}

export interface TelegramSourceOpts {
  now?: () => number;
  enabled?: () => boolean;
  /** «Важные» контакты — выше салиентность (по подстроке в title, без регистра). Опц. */
  importantContacts?: () => string[];
}

/** Короткий стабильный хеш строки (для ключа дедупа по тексту последнего сообщения). */
function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Чистая функция: непрочитанный чат → ambient-сигнал (или null, если заглушён/пуст). Для прямого юнит-теста. */
export function unreadSignal(chat: UnreadChat, userId: string, now: number, important: string[]): AmbientSignal | null {
  const title = (chat.title || "").trim();
  if (!title || !(chat.count > 0)) return null;
  const isImportant = important.some((c) => c && title.toLowerCase().includes(c.toLowerCase()));
  // Заглушённый чат — низкая важность (ниже дефолтного порога 0.5), важный контакт перебивает mute.
  const salience = isImportant ? 0.85 : chat.muted ? 0.3 : 0.7;
  const peer = (chat.peerId || title).replace(/\s+/g, "_");
  const previewKey = chat.preview ? shortHash(chat.preview) : String(chat.count);
  const cntWord = chat.count > 1 ? ` (${chat.count} новых)` : "";
  const prev = chat.preview ? ` — «${chat.preview.slice(0, 80)}»` : "";
  return {
    sourceId: "telegram",
    userId,
    key: `${peer}:${previewKey}`, // новое сообщение → новый preview/счёт → новый ключ → новое уведомление
    title: `Сэр, вам написал ${title} в Telegram${cntWord}${prev}.`,
    detail: chat.preview,
    salience,
    ts: now,
  };
}

/** Собрать ambient-источник Telegram поверх ридера расширения. owner — кому адресуем (один владелец). */
export function createTelegramSource(reader: TelegramUnreadReader, ownerUserId: string, opts: TelegramSourceOpts = {}): AmbientSource {
  const now = opts.now ?? Date.now;
  const enabled = opts.enabled ?? (() => true);
  const important = opts.importantContacts ?? (() => []);
  return {
    id: "telegram",
    label: "Telegram (непрочитанные)",
    enabled,
    poll: async () => {
      let res: UnreadResult;
      try {
        res = ((await reader.telegramUnread()) ?? {}) as UnreadResult;
      } catch (e) {
        log.debug("telegram.unread недоступен (расширение/вкладка) — пропуск", e instanceof Error ? e.message : String(e));
        return [];
      }
      if (res.noTab || !Array.isArray(res.unread)) return []; // нет открытой вкладки → не лезем (неинвазивно)
      const t = now();
      const imp = important();
      const out: AmbientSignal[] = [];
      for (const chat of res.unread) {
        const s = unreadSignal(chat, ownerUserId, t, imp);
        if (s) out.push(s);
      }
      return out;
    },
  };
}
