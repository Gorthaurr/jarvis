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
import { dataDir } from "../paths.js";

const log: Logger = createLogger("consent");
const DATA_DIR = dataDir(); // §универсальность: JARVIS_DATA_DIR (инсталлер) → иначе cwd/data
const CONSENT_PATH = join(DATA_DIR, "consent.json");

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
    cache = JSON.parse(await readFile(CONSENT_PATH, "utf8")) as Record<string, ConsentEntry>;
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
    await mkdir(DATA_DIR, { recursive: true });
    // Атомарно (tmp→rename): краш посреди записи иначе обрезал бы consent.json → на старте битый
    // JSON ловится в loadConsent и согласия МОЛЧА обнулялись бы (потеря всех «можно слать X»).
    const tmp = `${CONSENT_PATH}.tmp`;
    await writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
    await rename(tmp, CONSENT_PATH);
  } catch (e) {
    log.warn("согласие: не удалось сохранить", e instanceof Error ? e.message : String(e));
  }
}
