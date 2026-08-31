/**
 * Персистентное СОГЛАСИЕ на отправку (§14) — чтобы Джарвис спрашивал подтверждение на
 * отправку сообщения адресату ОДИН РАЗ, а дальше помнил НАВСЕГДА (и в следующих сессиях,
 * завтра — не переспрашивал). Фидбэк пользователя: «если сегодня сказал, что Кате можно
 * слать — не хочу завтра в новой сессии повторять».
 *
 * Хранится на диске (data/consent.json), переживает рестарт. Ключ — (userId, channel,
 * адресат-нормализованный). Это снижение трения, НЕ отмена защиты: первый раз спрашиваем
 * (новый адресат = осознанное решение), потом доверяем. Отзыв — revoke() («больше не шли X»).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import { lazyDataPath } from "../paths.js";

const log: Logger = createLogger("consent");
// ЛЕНИВО (волна E): путь берётся при первом обращении — .env грузится ПОСЛЕ ESM-импортов,
// иначе JARVIS_DATA_DIR инсталлера был бы мёртв (см. paths.lazyDataPath).
const dataRoot = lazyDataPath();
const consentPath = lazyDataPath("consent.json");

/** Одна запись согласия: когда одобрено (для возможной ревизии/аудита). */
interface ConsentEntry {
  ts: number;
}

let cache: Record<string, ConsentEntry> = {};

/** Нормализованный ключ согласия: один и тот же адресат в разном регистре/пробелах = один ключ. */
export function consentKey(userId: string, channel: string, recipient: string): string {
  return `${userId}:${channel}:${recipient.trim().toLowerCase()}`;
}

/** Загрузить согласия с диска (один раз на старте). Безопасно при отсутствии файла. */
export async function loadConsent(): Promise<void> {
  try {
    cache = JSON.parse(await readFile(consentPath(), "utf8")) as Record<string, ConsentEntry>;
    log.info("согласия на отправку загружены", { count: Object.keys(cache).length });
  } catch {
    cache = {};
    log.info("согласий на отправку нет (чистый старт)");
  }
}

/** Одобрена ли отправка этому адресату ранее (синхронно, из кеша). */
export function isSendApproved(userId: string, channel: string, recipient: string): boolean {
  return cache[consentKey(userId, channel, recipient)] !== undefined;
}

/** Запомнить согласие на отправку адресату (персист — переживает сессию/рестарт). */
export async function approveSend(userId: string, channel: string, recipient: string): Promise<void> {
  const key = consentKey(userId, channel, recipient);
  if (cache[key]) return;
  cache[key] = { ts: Date.now() };
  await persist();
  log.info("согласие на отправку сохранено (навсегда)", { channel, recipient });
}

/** Отозвать согласие («больше не шли X»). Возвращает true, если было что отзывать. */
export async function revokeSend(userId: string, channel: string, recipient: string): Promise<boolean> {
  const key = consentKey(userId, channel, recipient);
  if (!cache[key]) return false;
  delete cache[key];
  await persist();
  log.info("согласие на отправку отозвано", { channel, recipient });
  return true;
}

/**
 * 🔴 F4-контроль (HIGH): отозвать согласия ВСЕХ написаний одного адресата, а не одну строку.
 *
 * Корень: ключ согласия — сырой `to` из вызова модели (trim+lowercase), а модель называет одного
 * человека по-разному («Катя»/«Кате»/«Катя Любимая») — проект это уже знает и лечит стемами в
 * `peerIdentityKeys` ресенд-гарда. Поэтому у одного человека со временем копится НЕСКОЛЬКО ключей,
 * а точечный `revokeSend` снимал один — и владельцу при этом говорилось «следующая отправка снова
 * спросит подтверждения». Назавтра модель называла тот же контакт другим падежом, попадала в
 * оставшийся ключ и отправляла БЕЗ спроса: ложное заверение о §14-гейте.
 *
 * Матч: точное совпадение fold-имени ИЛИ общий стем (последняя гласная срезана, длина ≥4) — те же
 * правила, что в peerIdentityKeys. Возвращает СНЯТЫЕ адресаты (вызывающий обязан их показать —
 * владелец должен видеть, что именно перестало быть одобренным).
 */
export async function revokeSendMatching(userId: string, channel: string, recipient: string): Promise<string[]> {
  const target = recipient.trim().toLowerCase();
  if (!target) return [];
  const stem = (s: string): string => (s.length >= 4 ? s.replace(/[аеиоуыэюя]$/u, "") : s);
  const targetStem = stem(target);
  const removed: string[] = [];
  for (const c of listConsents(userId)) {
    if (c.channel !== channel.trim()) continue;
    const cand = c.recipient;
    if (cand !== target && stem(cand) !== targetStem) continue;
    delete cache[consentKey(userId, channel, cand)];
    removed.push(cand);
  }
  if (removed.length > 0) {
    await persist();
    log.info("согласия на отправку отозваны (все написания адресата)", { channel, removed });
  }
  return removed;
}

/**
 * F4 (волна F, «инспекция согласий» — идея OpenClaw «inspect or revoke that permission later»):
 * список ДЕЙСТВУЮЩИХ согласий пользователя. До этого consent.json был невидим (ни инструмента, ни UI),
 * а revokeSend — мёртвым кодом: владелец физически не мог узнать, кому Джарвис шлёт без переспроса,
 * и не мог отозвать. Только свои записи (ключ начинается с userId).
 */
export function listConsents(userId: string): Array<{ channel: string; recipient: string; ts: number }> {
  const prefix = `${userId}:`;
  const out: Array<{ channel: string; recipient: string; ts: number }> = [];
  for (const [key, entry] of Object.entries(cache)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const sep = rest.indexOf(":");
    if (sep <= 0) continue;
    out.push({ channel: rest.slice(0, sep), recipient: rest.slice(sep + 1), ts: entry.ts });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/** Только для тестов: сбросить кеш в памяти. */
export function _resetConsentForTest(): void {
  cache = {};
}

let writeChain: Promise<void> = Promise.resolve();

function persist(): Promise<void> {
  writeChain = writeChain.then(() => doPersist());
  return writeChain;
}

async function doPersist(): Promise<void> {
  try {
    await mkdir(dataRoot(), { recursive: true });
    // Атомарно (tmp→rename): краш посреди записи иначе обрезал бы consent.json → на старте битый
    // JSON ловится в loadConsent и согласия МОЛЧА обнулялись бы (потеря всех «можно слать X»).
    const tmp = `${consentPath()}.tmp`;
    await writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
    await rename(tmp, consentPath());
  } catch (e) {
    log.warn("согласие: не удалось сохранить", e instanceof Error ? e.message : String(e));
  }
}
