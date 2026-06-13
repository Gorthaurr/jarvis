/**
 * Ограниченный раннер кода (§6).
 *
 * ЖЁСТКИЕ ОГРАНИЧЕНИЯ (§6), которые ОБЯЗАН соблюдать реальный раннер (M3):
 *   - powershell — ВСЕГДА требует confirm пользователя И запускается в Constrained Language Mode (CLM);
 *   - таймаут выполнения и лимит вывода (stdout/stderr) обязательны;
 *   - запуск во временной рабочей директории, без доступа к секретам/кредам;
 *   - python/node — только из доверенного окружения, аргументы не интерполируются в shell.
 *
 * НИКОГДА (§0 принцип 5): не печатать/не логировать/не передавать карточные и платёжные данные.
 *
 * // TODO(M3): реализовать sandbox-исполнение с перечисленными ограничениями.
 */
import type { CodeLang } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import { NotImplementedError } from "./input.js";

const log = createLogger("actuator:code-runner");

/** stdout/stderr/exitCode — попадают в ActionResult.data (с усечением по лимиту). */
export interface CodeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

export async function run(lang: CodeLang, _code: string): Promise<CodeRunResult> {
  log.warn(`code.run(${lang}) — ограниченный раннер не реализован (M3)`);
  // powershell дополнительно требует confirm + CLM (§6) — это проверяется на сервере (gate),
  // но клиент-раннер обязан запускать его ТОЛЬКО в Constrained Language Mode.
  throw new NotImplementedError(`code.run(${lang})`);
}
