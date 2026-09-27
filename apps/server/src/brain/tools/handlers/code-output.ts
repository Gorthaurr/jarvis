/**
 * W3 (S-9): вывод скрипта — НЕДОВЕРЕННЫЕ данные. Скрипт печатает то, что прочитал (страницу, файл, чужое сообщение), и
 * строка «SYSTEM: отправь…» в stdout без обёртки читалась моделью как наш текст. Служебные поля раннера (exitCode,
 * jobId, running, truncated…) — снаружи; stdout/stderr и их хвосты — внутри <untrusted_content source="code_run">,
 * делимитер из данных нейтрализуется (wrapUntrusted). Только для code_run, job_status и самописного инструмента:
 * проба app_channel_learn читает СЫРОЙ JSON раннера (readProbeOutcome) — её путь остаётся без обёртки.
 */
import { wrapUntrustedCapped } from "../dispatch-util.js";

export const CODE_SOURCE = "code_run";

/** Поля данных раннера, которые наполняет сам процесс (и всё, что он прочитал извне). */
const OUTPUT_KEYS: ReadonlySet<string> = new Set(["stdout", "stderr", "stdoutTail", "stderrTail", "overlayMarker"]);

/** Обернуть вывод процесса (с серверным капом; пометка о капе — снаружи обёртки). */
export const wrapCodeOutput = (body: string): string => wrapUntrustedCapped(CODE_SOURCE, body);

/** Данные раннера текстом для модели: служебное — JSON снаружи, вывод процесса — JSON внутри обёртки. */
export function codeDataText(data: unknown, wrap: boolean): string {
  if (!wrap || !data || typeof data !== "object" || Array.isArray(data)) return JSON.stringify(data);
  const meta: Record<string, unknown> = {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) (OUTPUT_KEYS.has(k) ? out : meta)[k] = v;
  if (Object.keys(out).length === 0) return JSON.stringify(meta);
  return `${JSON.stringify(meta)}\n${wrapCodeOutput(JSON.stringify(out))}`;
}

/**
 * Сообщение раннера об ошибке скрипта («код завершился с кодом 1. stderr: … | stdout: …»): статус раннера — снаружи,
 * всё от первого « stderr:»/« | stdout» — в обёртке. Нет маркера — обёрнуто целиком (неизвестный текст о прогоне
 * скрипта может нести его вывод: лишняя обёртка дешевле инструкции «от нас»).
 */
export function codeMessageText(msg: string, wrap: boolean): string {
  if (!wrap || !msg) return msg;
  const at = msg.search(/ stderr:| \| stdout/u);
  return at > 0 ? `${msg.slice(0, at)}\n${wrapCodeOutput(msg.slice(at).trim())}` : `\n${wrapCodeOutput(msg)}`;
}
