/**
 * Журнал сон-цикла (волна F, F3 — идея Dream Diary у OpenClaw): durable-след «что консолидация
 * реально сделала этой ночью». Раньше итог жил ТОЛЬКО в консольном log.info и выбрасывался
 * (`void consolidateMemory(...)` в server.ts) — владелец не мог узнать, что и когда осело в его
 * профиль фоновым LLM. Показывается во вкладке «Память». Append-only JSONL, fail-safe (сбой ФС не
 * ломает консолидацию), лёгкая ротация по числу строк (прогонов максимум 1/день — файл растёт медленно).
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import { lazyDataPath } from "../paths.js";

const log: Logger = createLogger("consolidation:journal");

const memoryDir = lazyDataPath("memory");
const MAX_LINES = 200; // ~полгода ежедневных прогонов; старейшие срезаются при ротации

export interface ConsolidationRunRecord {
  /** unix ms прогона. */
  ts: number;
  /** Сколько фактов извлёк LLM (до дедупа). */
  extracted: number;
  /** Сколько реально записано (после дедупа). */
  written: number;
  /** Сколько отброшено анти-инъекционным фильтром (директивы/контакты). */
  dropped: number;
  /** Тексты записанных фактов (владелец видит, ЧТО именно осело). */
  facts: string[];
}

function journalFile(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "default";
  return join(memoryDir(), `consolidation-${safe}.jsonl`);
}

/** Дописать запись прогона. Fail-safe: сбой ФС — WARN, не исключение. */
export async function appendConsolidationRun(userId: string, rec: ConsolidationRunRecord): Promise<void> {
  try {
    const file = journalFile(userId);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(rec)}\n`, "utf8");
    // Ротация по числу строк: читаем только при подозрении на разрастание (дёшево — файл мал).
    const raw = await readFile(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length > MAX_LINES) {
      await writeFile(file, `${lines.slice(-MAX_LINES).join("\n")}\n`, "utf8");
    }
  } catch (e) {
    log.warn("журнал сон-цикла: запись не удалась", { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Прочитать последние прогоны (новые первыми). Нет файла/сбой → []. */
export async function readConsolidationRuns(userId: string, limit = 20): Promise<ConsolidationRunRecord[]> {
  try {
    const raw = await readFile(journalFile(userId), "utf8");
    const out: ConsolidationRunRecord[] = [];
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const rec = JSON.parse(s) as ConsolidationRunRecord;
        if (typeof rec.ts !== "number") continue;
        out.push({
          ts: rec.ts,
          extracted: Number(rec.extracted) || 0,
          written: Number(rec.written) || 0,
          dropped: Number(rec.dropped) || 0,
          facts: Array.isArray(rec.facts) ? rec.facts.filter((f): f is string => typeof f === "string") : [],
        });
      } catch {
        /* битая строка — пропускаем */
      }
    }
    return out.reverse().slice(0, limit);
  } catch {
    return [];
  }
}
