/**
 * ДОКЛАД ВЛАДЕЛЬЦУ О ДЛИТЕЛЬНОМ ОТСУТСТВИИ РАСШИРЕНИЯ (учёт — ext-absence.ts). Правила — как у доклада о сбоях
 * (router-ws `flushIncidentReport`): только когда владелец ЗДЕСЬ (его реплика), не в занятость (полный экран/
 * звонок/блокировка — флаг доклада НЕ тратим), текст в чат + голос. Отличие: проверяется на КАЖДОЙ реплике, а не
 * раз за соединение — порог часто пересекается посреди многодневной сессии клиента в трее.
 *
 * Голос — узкий канал (закон 4): коротко, без дат и путей («с двадцать четыре сентября» verbalize не склоняет).
 * Факт о Chrome — в ПРОШЕДШЕМ времени: к моменту реплики его могли закрыть (закон 1). Путь и шаги — в чат.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Logger, createLogger } from "@jarvis/shared";
import type { ExtAbsence, ExtAbsenceDue } from "./ext-absence.js";
import { pinnedExtIdOrDefault } from "./ext-id.js";

const log: Logger = createLogger("ext-absence");

/** Папка распакованного расширения (apps/extension) — если она рядом с сервером И собрана (SW = dist/background.js). */
export function extensionDir(): string | null {
  try {
    const dir = fileURLToPath(new URL("../../../extension", import.meta.url));
    return existsSync(join(dir, "manifest.json")) && existsSync(join(dir, "dist", "background.js")) ? dir : null;
  } catch {
    return null;
  }
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Две реплики: голосом (коротко) и в чат (с шагами). Чистая функция. */
export function formatExtAbsence(d: ExtAbsenceDue, dir: string | null, expectedId = pinnedExtIdOrDefault(process.env.JARVIS_EXT_ID)): { voice: string; chat: string } {
  const at = d.lastSeenAt === null ? null : new Date(d.lastSeenAt);
  const since = at ? ` (последний раз на связи ${pad(at.getDate())}.${pad(at.getMonth() + 1)} в ${at.getHours()}:${pad(at.getMinutes())})` : "";
  const loss = "Без него не работают вкладки, Telegram, почта и календарь из браузера.";
  if (d.pinRejectedId) {
    return {
      voice: "Сэр, руки в браузере отключены: моё расширение стучится с чужим номером, и я его не пускаю. Подробности написал в чат.",
      chat:
        `Руки в браузере отключены: расширение из Chrome подключается с ID ${d.pinRejectedId}, а сервер ждёт ${expectedId} и отклоняет его${since}. ` +
        `${loss} Проверьте JARVIS_EXT_ID в .env сервера и поле key в apps/extension/manifest.json, затем перезапустите сервер.`,
    };
  }
  const remedy =
    `Вернуть: chrome://extensions → включите «Режим разработчика» → «Загрузить распакованное» → папка ` +
    `${dir ?? "apps/extension в репозитории Джарвиса (сначала сборка клиента: node apps/client/scripts/build.mjs)"}. ` +
    "Если расширение уже в списке — включите его и нажмите «Обновить» (⟳).";
  if (d.kind === "chrome") {
    const min = Math.round(d.chromeMs / 60_000);
    return {
      voice: "Сэр, руки в браузере отключены: Chrome у вас работал, а моё расширение так и не вышло на связь. Как вернуть — написал в чат.",
      chat: `Руки в браузере отключены: Chrome был у вас на экране около ${min} мин, а расширение «Jarvis Web Hands» так и не вышло на связь${since}. ${loss} ${remedy}`,
    };
  }
  const hours = Math.round(d.absentMs / 3_600_000);
  return {
    voice: "Сэр, моё расширение Chrome давно не выходит на связь. Если Chrome у вас открыт — его стоит вернуть, как — написал в чат.",
    chat:
      `Расширение «Jarvis Web Hands» не выходит на связь уже около ${hours} ч работы ПК${since}. Если Chrome просто закрыт — ` +
      `оно подключится при запуске; если открыт — расширение пропало. ${loss} ${remedy}`,
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
  /** Текстовая копия в чат (переживает провал TTS/barge-in/TTL очереди). */
  chat(text: string): void;
  /** Папка расширения (тестам — подмена; по умолчанию — рядом с сервером). */
  dir?: string | null;
}

/** Сказать владельцу, если пора. true — сказано (этот вид доклада потрачен до восстановления связи). */
export function flushExtAbsence(d: ExtAbsenceFlushDeps): boolean {
  const due = d.tracker.due(d.connected);
  if (!due) return false;
  if (d.ownerBusy) {
    log.info("отсутствие расширения: доклад отложен — владелец занят (флаг не потрачен)");
    return false;
  }
  const text = formatExtAbsence(due, d.dir === undefined ? extensionDir() : d.dir);
  d.tracker.markReported(due.kind); // ДО речи: сбой озвучки не должен превращать доклад в повтор на каждой реплике
  d.chat(text.chat); // чат ПЕРВЫМ: голос теряется TTL очереди/barge-in/смертью сессии, копия в чате — нет
  d.speak(text.voice);
  log.info("отсутствие расширения: доклад отдан владельцу (чат + голос)", { kind: due.kind, pin: due.pinRejectedId !== null });
  return true;
}
