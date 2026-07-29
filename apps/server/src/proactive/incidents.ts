/**
 * ГОЛОСОВОЙ ДОКЛАД О СОБСТВЕННЫХ СБОЯХ (аудит 2026-07-28, P0 «умер ночью — никто не узнал»).
 *
 * Внешние каналы алертов (Telegram-бот, системный toast) требуют настройки, а Джарвис — ГОЛОСОВОЙ
 * ассистент: самый естественный и не требующий ничего канал — сказать самому. Супервизор
 * (`infra/supervisor.mjs`) durable-пишет инциденты в `dataDir/incidents.jsonl`; сервер при первом
 * подключении владельца читает НЕдоложенные и произносит короткую сводку («ночью я дважды падал,
 * поднялся сам»), после чего двигает маркер прочитанного.
 *
 * Принципы:
 *  • ЧЕСТНОСТЬ: докладываем факт и время, без «всё хорошо» — если падал, владелец узнает;
 *  • НЕ спам: одна сводка на все инциденты, окно 24ч, старое молчаливо устаревает (маркер двигается);
 *  • fail-safe: любой сбой ФС → пустая сводка (лог не критичен для работы).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import { dataPath } from "../paths.js";

const log: Logger = createLogger("incidents");

/** Одна запись о сбое (пишет супервизор; сервер только читает). */
export interface Incident {
  /** ISO-время события. */
  ts: string;
  /** Тип: crash (сервер упал), health (не отвечал /healthz), takeover, crash-loop. */
  kind: string;
  /** Человеческое описание (уже готово к озвучке). */
  text: string;
}

/** Окно давности: инциденты старше суток не докладываем (но маркер двигаем — не копим хвост). */
const REPORT_WINDOW_MS = 24 * 3_600_000;
/** Максимум инцидентов в разборе (анти-спам при шторме рестартов). */
const MAX_INCIDENTS = 50;

function incidentsFile(): string {
  return dataPath("incidents.jsonl");
}
function markerFile(): string {
  return dataPath("incidents-reported.json");
}

/** Записать инцидент (используется сервером для собственных «мягких» сбоев; супервизор пишет сам). */
export function recordIncident(kind: string, text: string): void {
  try {
    const file = incidentsFile();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), kind, text })}\n`, "utf8");
  } catch (e) {
    log.warn("не удалось записать инцидент", { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Время последнего доложенного инцидента (unix ms); 0 — не докладывали ничего. */
function lastReportedAt(): number {
  try {
    const raw = JSON.parse(readFileSync(markerFile(), "utf8")) as { lastReportedAt?: number };
    return typeof raw.lastReportedAt === "number" ? raw.lastReportedAt : 0;
  } catch {
    return 0;
  }
}

/** Сдвинуть маркер прочитанного (после озвучки ИЛИ после устаревания). */
export function markIncidentsReported(upToMs: number): void {
  try {
    const file = markerFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ lastReportedAt: upToMs }), "utf8");
  } catch (e) {
    log.warn("не удалось сдвинуть маркер инцидентов", { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Прочитать инциденты, о которых владельцу ещё не докладывали (в порядке появления). */
export function readUnreportedIncidents(now = Date.now()): Incident[] {
  const file = incidentsFile();
  if (!existsSync(file)) return [];
  const since = lastReportedAt();
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch (e) {
    log.warn("не удалось прочитать инциденты", { error: e instanceof Error ? e.message : String(e) });
    return [];
  }
  const out: Incident[] = [];
  for (const line of lines.slice(-MAX_INCIDENTS * 4)) {
    try {
      const inc = JSON.parse(line) as Incident;
      const ts = Date.parse(inc.ts);
      if (!Number.isFinite(ts) || ts <= since) continue; // уже доложено
      if (now - ts > REPORT_WINDOW_MS) continue; // слишком старое — не тревожим (маркер сдвинет вызывающий)
      out.push(inc);
    } catch {
      /* битая строка — пропускаем */
    }
  }
  return out.slice(-MAX_INCIDENTS);
}

/** Час:минута по-русски для короткой фразы («в 3:40»). Чистая функция. */
function hhmm(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Русская плюрализация «раз/раза» (адверс-ревью: было всегда «раза» → «пять раза»). Чистая. */
function timesWord(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return "раз";
  if (mod10 === 1) return "раз";
  if (mod10 >= 2 && mod10 <= 4) return "раза";
  return "раз";
}

/**
 * Свести инциденты в ОДНУ короткую честную фразу для озвучки. Пусто → null (докладывать нечего).
 * Чистая функция — тестируется без ФС.
 */
export function formatIncidentReport(incidents: readonly Incident[]): string | null {
  if (incidents.length === 0) return null;
  const last = incidents[incidents.length - 1]!;
  const when = hhmm(last.ts);
  if (incidents.length === 1) {
    return `Небольшой доклад, сэр: ${last.text}${when ? ` — это было в ${when}` : ""}. Сейчас всё работает.`;
  }
  const crashes = incidents.filter((i) => i.kind === "crash" || i.kind === "downtime").length;
  const detail = crashes > 0 && crashes === incidents.length ? "я был недоступен и восстанавливался сам" : "у меня были сбои, восстановился сам";
  return (
    `Небольшой доклад, сэр: пока вас не было, ${detail} — ${incidents.length} ${timesWord(incidents.length)}` +
    `${when ? `, последний раз в ${when}` : ""}. Сейчас всё работает.`
  );
}

/**
 * Сводка о сбоях для озвучки при подключении владельца (null — докладывать нечего).
 * Побочный эффект: двигает маркер прочитанного (в т.ч. по устаревшим — чтобы не копить хвост).
 */
export function takeIncidentReport(now = Date.now()): string | null {
  const fresh = readUnreportedIncidents(now);
  const line = formatIncidentReport(fresh);
  // Маркер двигаем ВСЕГДА (даже если всё устарело/пусто) — иначе старые записи каждый коннект
  // перечитываются заново; при этом свежие уже озвучены, повтора не будет.
  markIncidentsReported(now);
  if (line) log.info("инциденты: готова сводка для владельца", { count: fresh.length });
  return line;
}
