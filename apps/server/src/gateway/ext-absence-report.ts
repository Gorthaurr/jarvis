/**
 * ДОКЛАД ВЛАДЕЛЬЦУ О ДЛИТЕЛЬНОМ ОТСУТСТВИИ РАСШИРЕНИЯ (учёт — ext-absence.ts). Правила — как у доклада о сбоях
 * (router-ws `flushIncidentReport`): только когда владелец ЗДЕСЬ (его реплика), не в занятость (полный экран/
 * звонок/блокировка — флаг доклада НЕ тратим), голос + текстовая копия в чат. Отличие: проверяется на КАЖДОЙ
 * реплике, а не раз за соединение — порог часто пересекается посреди многодневной сессии клиента в трее.
 *
 * Голос — узкий канал (закон 4): коротко, без путей. Путь и шаги — в чат: «chrome://extensions → Загрузить
 * распакованное → <папка apps/extension>» (Chrome помнит ПУТЬ распакованного: переезд папки = молча удалено).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Logger, createLogger } from "@jarvis/shared";
import type { ExtAbsence, ExtAbsenceDue } from "./ext-absence.js";

const log: Logger = createLogger("ext-absence");

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/** Папка распакованного расширения (apps/extension), если она рядом с сервером; иначе null (сборка/инсталлер). */
export function extensionDir(): string | null {
  try {
    const dir = fileURLToPath(new URL("../../../extension", import.meta.url));
    return existsSync(join(dir, "manifest.json")) ? dir : null;
  } catch {
    return null;
  }
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Две реплики: голосом (коротко) и в чат (с путём и шагами). Чистая функция. */
export function formatExtAbsence(d: ExtAbsenceDue, dir: string | null): { voice: string; chat: string } {
  const at = d.lastSeenAt === null ? null : new Date(d.lastSeenAt);
  const sinceVoice = at ? ` с ${at.getDate()} ${MONTHS[at.getMonth()]}` : "";
  const sinceChat = at ? ` с ${pad(at.getDate())}.${pad(at.getMonth() + 1)} ${at.getHours()}:${pad(at.getMinutes())}` : "";
  const hours = Math.round(d.absentMs / 3_600_000);
  const remedy =
    `Вернуть: chrome://extensions → включите «Режим разработчика» → «Загрузить распакованное» → папка ` +
    `${dir ?? "apps/extension в репозитории Джарвиса"}. Если расширение уже в списке — включите его и нажмите «Обновить» (⟳).`;
  const loss = "Без него не работают вкладки, Telegram, почта и календарь из браузера.";
  if (d.kind === "chrome") {
    return {
      voice: `Сэр, руки в браузере отключены: Chrome открыт, а моё расширение не на связи${sinceVoice}. Как вернуть — написал в чат.`,
      chat: `Руки в браузере отключены: Chrome открыт, а расширение «Jarvis Web Hands» не на связи${sinceChat}. ${loss} ${remedy}`,
    };
  }
  return {
    voice: `Сэр, моё расширение Chrome давно не выходит на связь${sinceVoice}. Если Chrome у вас открыт — его стоит вернуть, как — написал в чат.`,
    chat:
      `Расширение «Jarvis Web Hands» не выходит на связь${sinceChat} (наблюдаю около ${hours} ч). Если Chrome закрыт — ` +
      `всё в порядке, при запуске оно подключится само. Если открыт — расширение пропало. ${loss} ${remedy}`,
  };
}

export interface ExtAbsenceFlushDeps {
  tracker: ExtAbsence;
  /** Живой флаг моста прямо сейчас. */
  connected: boolean;
  /** Владелец занят (полный экран/звонок/блокировка) — §9 «не мешать». */
  ownerBusy: boolean;
  /** Озвучить (несрочная очередь; verbalize — на стороне вызывающего). */
  speak(text: string): void;
  /** Текстовая копия в чат (переживает провал TTS/barge-in). */
  chat(text: string): void;
  /** Папка расширения (тестам — подмена; по умолчанию — рядом с сервером). */
  dir?: string | null;
}

/** Сказать владельцу, если пора. true — сказано (флаг доклада потрачен до восстановления связи). */
export function flushExtAbsence(d: ExtAbsenceFlushDeps): boolean {
  const due = d.tracker.due(d.connected);
  if (!due) return false;
  if (d.ownerBusy) {
    log.info("отсутствие расширения: доклад отложен — владелец занят (флаг не потрачен)");
    return false;
  }
  const text = formatExtAbsence(due, d.dir === undefined ? extensionDir() : d.dir);
  d.tracker.markReported(); // ДО речи: сбой озвучки не должен превращать доклад в повтор на каждой реплике
  d.speak(text.voice);
  d.chat(text.chat);
  log.info("отсутствие расширения: доклад отдан владельцу (голос + чат)", { kind: due.kind, absentH: Math.round(due.absentMs / 3_600_000) });
  return true;
}
