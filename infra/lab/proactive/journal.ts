/**
 * Журнал проактива: что озвучено (звук реально ушёл клиенту), что поставлено в очередь / отказано, исходы, команды
 * агентской петле, чат. Каждая запись несёт метку ВИРТУАЛЬНОГО времени - по ней проверяем «ровно в срок».
 */
export type JournalKind =
  | "queued" // очередь озвучки приняла реплику
  | "refused" // очередь отказала (false)
  | "sound" // первый чанк звука ушёл клиенту = «прозвучало»
  | "outcome" // onOutcome(spoken)
  | "action" // сервис запустил поручение в агентской петле (goal)
  | "predicate" // клиенту ушёл wait.for предиката
  | "mark"; // служебная отметка сценария (рестарт, подключение)

export interface JournalEntry {
  at: number;
  kind: JournalKind;
  /** Источник реплики: reminder | watch | ambient | direct. */
  source?: string;
  text?: string;
  detail?: Record<string, unknown>;
}

export class Journal {
  readonly entries: JournalEntry[] = [];

  add(kind: JournalKind, e: Omit<JournalEntry, "at" | "kind"> = {}): void {
    this.entries.push({ at: Date.now(), kind, ...e });
  }

  of(kind: JournalKind): JournalEntry[] {
    return this.entries.filter((e) => e.kind === kind);
  }

  /** Тексты, что реально прозвучали, в порядке звучания. */
  spoken(): string[] {
    return this.of("sound").map((e) => e.text ?? "");
  }

  /** Что прозвучало в конкретной сессии (мульти-девайс / чужой пользователь). */
  spokenBy(sessionId: string): string[] {
    return this.of("sound").filter((e) => e.detail?.session === sessionId).map((e) => e.text ?? "");
  }

  /** Виртуальные моменты звучания (мс) для проверки «ровно в срок». */
  soundTimes(): number[] {
    return this.of("sound").map((e) => e.at);
  }

  goals(): string[] {
    return this.of("action").map((e) => e.text ?? "");
  }

  /** Для сообщений об ошибках: хронология одной строкой на запись. */
  dump(fmt: (ts: number) => string): string {
    return this.entries.map((e) => `${fmt(e.at)} ${e.kind}${e.source ? `[${e.source}]` : ""} ${e.text ?? ""}`).join("\n");
  }
}
