/**
 * Окружение ИЗОЛИРОВАННОГО лаб-сервера: env-файл (JARVIS_ENV_PATH — чтобы боевой .env не перебил PORT/HOST/DATABASE_URL)
 * и env процесса (чистый белый список, а не наследование: ни токенов агента, ни прокси, ни ключей владельца).
 * Секреты (Deepgram, подписка) — ТОЛЬКО в env процесса на время его жизни, в файл они не попадают никогда.
 */
import { existsSync, readFileSync } from "node:fs";
import { repoRoot } from "./deps.js";
import type { LabServerOptions } from "./contracts.js";

/** Значения, безопасные для env-файла (не секреты): куда качать модели и как их считать. Берутся у владельца, если заданы. */
const OWNER_SAFE_VARS = ["HF_ENDPOINT", "JARVIS_EMBED_DEVICE", "JARVIS_EMBED_DTYPE"] as const;

/** Переменные родителя, без которых Node/tsx на Windows не работает (winsock требует SystemRoot). Остальное не наследуем. */
const PROCESS_PASS = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "TEMP", "TMP", "TMPDIR",
  "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "TZ",
] as const;

/** Прочитать ОДНУ переменную: окружение → .env владельца (только запрошенное имя, остальное не разбираем и не печатаем). */
export function readOwnerVar(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const own = env[name]?.trim();
  if (own) return own;
  const file = repoRoot(".env");
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/u)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/u.exec(line);
    if (m && m[1] === name) return m[2]?.replace(/^(["'])(.*)\1$/u, "$2") || undefined;
  }
  return undefined;
}

export interface ServerEnvPlan {
  /** Содержимое server.env (без секретов). */
  file: Record<string, string>;
  /** Env дочернего процесса (белый список + секреты на время жизни). */
  proc: Record<string, string>;
}

export interface EnvInput extends LabServerOptions {
  port: number;
  dataDir: string;
  pgdata: string;
  devToken: string;
  /** Источник окружения (для тестов). */
  parentEnv?: NodeJS.ProcessEnv;
  /** Читать .env владельца (для тестов выключается). */
  readOwner?: (name: string) => string | undefined;
}

/** Собрать env-файл и env процесса. Чистая функция: вся политика изоляции видна в одном месте и тестируется без запуска. */
export function planServerEnv(o: EnvInput): ServerEnvPlan {
  const brain = o.brain ?? "off";
  const stt = o.stt ?? "mock";
  const parent = o.parentEnv ?? process.env;
  const owner = o.readOwner ?? ((n: string) => readOwnerVar(n, parent));
  const file: Record<string, string> = {
    PORT: String(o.port),
    HOST: "127.0.0.1",
    JARVIS_DEV_HTTP: "1",
    JARVIS_DEV_TOKEN: o.devToken,
    JARVIS_DATA_DIR: o.dataDir,
    DATABASE_URL: `pglite://${o.pgdata}`,
    STT_PROVIDER: stt === "deepgram" ? "deepgram" : "mock",
    JARVIS_SPEAKER_GATE: "0",
    JARVIS_AMBIENT_TELEGRAM: "0",
    JARVIS_AMBIENT_MAIL: "0",
    JARVIS_AMBIENT_CALENDAR: "0",
    JARVIS_SKILL_DISTILL: "0",
    JARVIS_PRIMARY_LLM: "0", // API по ключу не оплачиваем: ни одной HTTP-пробы на ход
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_BASE_URL: "",
  };
  const proc: Record<string, string> = {};
  for (const k of PROCESS_PASS) if (parent[k]) proc[k] = parent[k] as string;
  for (const k of OWNER_SAFE_VARS) {
    const v = owner(k);
    if (v) file[k] = v;
  }
  if (brain === "off") {
    file.JARVIS_SUBSCRIPTION_FALLBACK = "0"; // без резерва на подписку → мозга нет, ход честно упрётся в «связь прервалась»
    file.CLAUDE_CODE_OAUTH_TOKEN = "";
  } else if (brain === "real") {
    // Подписка владельца: токен пробросом в env процесса (не в файл). Нет токена — остаётся stored-login (USERPROFILE).
    const token = owner("CLAUDE_CODE_OAUTH_TOKEN");
    if (token) proc.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
  if (stt === "deepgram") {
    const key = owner("DEEPGRAM_API_KEY");
    if (!key) throw new Error("stt:'deepgram' — DEEPGRAM_API_KEY не найден ни в окружении, ни в .env владельца");
    proc.DEEPGRAM_API_KEY = key;
  }
  // Свои переменные вызывающего — в env процесса; из файла убираем совпадающие ключи (dotenv override:true иначе перебил бы их).
  for (const [k, v] of Object.entries(o.env ?? {})) {
    proc[k] = v;
    delete file[k];
  }
  proc.JARVIS_ENV_PATH = ""; // выставит вызывающий: путь к файлу известен только после записи
  proc.TSX_TSCONFIG_PATH = repoRoot("apps/server/tsconfig.json");
  return { file, proc };
}

/** Строки env-файла. Значения без кавычек: пути даём с прямыми слэшами, `#` и пробелов в них нет (проверяет вызывающий). */
export function renderEnvFile(file: Record<string, string>): string {
  return `${Object.entries(file).map(([k, v]) => `${k}=${v}`).join("\n")}\n`;
}
