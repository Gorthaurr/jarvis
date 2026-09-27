/**
 * Стенд: сериализация ToolResult/Task в JSON-ответ /dev/bench/* — флаги честности (sent/declined/uncertain/observed…)
 * отдаём как есть, картинку — base64 с типом и размером (сценарий проверяет, что снимок реально пришёл).
 */
import type { ToolResult } from "../../brain/tools/dispatch.js";
import type { Task } from "../../brain/tasks/task.js";

const FLAG_KEYS = [
  "sent",
  "declined",
  "uncertain",
  "observed",
  "empty",
  "channelDown",
  "overlayDenied",
  "veiled",
  "jobLaunched",
] as const;

export type BenchContent =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; bytes: number; data: string };

export interface BenchToolResult {
  isError: boolean;
  text: string;
  content: BenchContent[];
  flags: Record<string, boolean | string>;
  data?: unknown;
}

export function serializeToolResult(r: ToolResult): BenchToolResult {
  const content: BenchContent[] =
    typeof r.content === "string"
      ? [{ type: "text", text: r.content }]
      : r.content.map((b) =>
          b.type === "text"
            ? { type: "text" as const, text: b.text }
            : { type: "image" as const, mediaType: b.source.media_type, bytes: Buffer.from(b.source.data, "base64").length, data: b.source.data },
        );
  const flags: Record<string, boolean | string> = {};
  for (const k of FLAG_KEYS) if (r[k] !== undefined) flags[k] = r[k] as boolean;
  if (r.backgroundJob) flags.backgroundJob = r.backgroundJob;
  return {
    isError: r.isError === true,
    text: content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n"),
    content,
    flags,
    ...(r.data !== undefined ? { data: r.data } : {}),
  };
}

export interface BenchTask {
  taskId: string;
  state: string;
  title: string;
  goal: string;
  stepsDone: number;
  resultSummary: string | null;
  lastError: string | null;
  irreversibleDone: string[];
  dev: boolean;
  startedAt: number;
}

export function serializeTask(t: Task): BenchTask {
  return {
    taskId: t.taskId,
    state: t.state,
    title: t.title,
    goal: t.goal,
    stepsDone: t.stepsDone,
    resultSummary: t.resultSummary ?? null,
    lastError: t.lastError ?? null,
    irreversibleDone: [...(t.irreversibleDone ?? [])],
    dev: t.dev === true,
    startedAt: t.startedAt,
  };
}
