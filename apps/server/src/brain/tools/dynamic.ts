/**
 * Саморасширение (§8+): Джарвис пишет себе НОВЫЕ инструменты, когда штатных не хватает.
 *
 * Динамический инструмент = именованный шаблон кода (python/node/powershell) с описанием
 * и параметрами. После создания он становится ПЕРВОКЛАССНЫМ tool'ом в наборе модели
 * (asToolSchemas) — на следующем ходу Джарвис вызывает его как обычный инструмент.
 * Исполнение идёт через тот же гард­ированный code.run (lint §6 + клиентский раннер),
 * поэтому самописный инструмент не обходит предохранители.
 *
 * Персист — data/dynamic-tools.json (переживает рестарт): выученное остаётся навыком.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CodeLang } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import type { ToolSchema } from "@jarvis/tools";
import { lintCode } from "../code-guard.js";

const log: Logger = createLogger("dynamic-tools");

const DATA_DIR = join(process.cwd(), "data");
const STORE_PATH = join(DATA_DIR, "dynamic-tools.json");

/** Имена-плейсхолдеры подстановки в шаблоне кода: {{param}}. */
const PLACEHOLDER = (name: string): RegExp => new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, "g");

const VALID_LANGS: ReadonlySet<string> = new Set(["python", "node", "powershell"]);
/** Имя инструмента: snake_case, 3-41 символ (видно модели как имя tool'а). */
const NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;
/** Имя параметра: короткие тоже ок (q, x, n) — это лишь ключ подстановки {{имя}}. */
const PARAM_NAME_RE = /^[a-z][a-z0-9_]{0,30}$/;
const MAX_TOOLS = 200;

export interface DynamicToolParam {
  name: string;
  description?: string;
}

export interface DynamicTool {
  /** Уникальное snake_case имя (видно модели как имя инструмента). */
  name: string;
  description: string;
  lang: CodeLang;
  /** Шаблон кода с плейсхолдерами {{param}}. */
  code: string;
  params: DynamicToolParam[];
  createdAt: number;
  runCount: number;
}

export interface CreateResult {
  ok: boolean;
  error?: string;
}

export interface RenderResult {
  ok: boolean;
  lang?: CodeLang;
  code?: string;
  error?: string;
}

/**
 * Реестр самописных инструментов. Один на gateway (как профиль). Знает зарезервированные
 * имена встроенных инструментов, чтобы самописный не затенял штатный.
 */
export class DynamicToolStore {
  private tools = new Map<string, DynamicTool>();
  private readonly now: () => number;
  private readonly storePath: string;

  constructor(
    /** Имена встроенных инструментов — самописный не должен их перекрывать. */
    private readonly reservedNames: ReadonlySet<string>,
    opts: { now?: () => number; storePath?: string } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.storePath = opts.storePath ?? STORE_PATH;
  }

  /** Загрузить с диска (один раз на старте). Безопасно при отсутствии файла. */
  async load(): Promise<void> {
    const parse = async (path: string): Promise<DynamicTool[] | null> => {
      try {
        return JSON.parse(await readFile(path, "utf8")) as DynamicTool[];
      } catch {
        return null;
      }
    };
    // Основной файл, при битости — резервная копия (защита от потери навыков).
    const raw = (await parse(this.storePath)) ?? (await parse(`${this.storePath}.bak`));
    if (!raw) {
      this.tools = new Map();
      return;
    }
    // Те же гарды, что при create: валидное имя, НЕ зарезервировано, код проходит lint
    // (ужесточённый гард ретроактивно отбраковывает устаревшие/опасные шаблоны).
    const valid = raw.filter(
      (t) =>
        t &&
        NAME_RE.test(t.name) &&
        !this.reservedNames.has(t.name) &&
        VALID_LANGS.has(t.lang) &&
        lintCode(t.lang, t.code).ok,
    );
    this.tools = new Map(valid.map((t) => [t.name, t]));
    log.info("самописные инструменты загружены", { count: this.tools.size, dropped: raw.length - valid.length });
  }

  /** Создать/обновить инструмент. Валидирует имя/язык/код (lint §6) перед сохранением. */
  async create(input: {
    name: string;
    description: string;
    lang: string;
    code: string;
    params?: DynamicToolParam[];
  }): Promise<CreateResult> {
    const name = String(input.name ?? "").trim().toLowerCase();
    if (!NAME_RE.test(name)) return err("имя: snake_case, 3-41 символ, начинается с буквы");
    if (this.reservedNames.has(name)) return err(`имя «${name}» занято встроенным инструментом`);
    const lang = String(input.lang ?? "");
    if (!VALID_LANGS.has(lang)) return err("lang: python | node | powershell");
    const code = String(input.code ?? "");
    if (!code.trim()) return err("пустой code");
    if (this.tools.size >= MAX_TOOLS && !this.tools.has(name)) return err("достигнут лимит самописных инструментов");

    // Валидируем шаблон гардом (§6): самописный инструмент не должен обходить запреты.
    const lint = lintCode(lang as CodeLang, code);
    if (!lint.ok) return err(`код отклонён гардом (§6): ${lint.violations.map((v) => v.message).join("; ")}`);

    const description = String(input.description ?? "").trim() || `Самописный инструмент ${name}`;
    const params = (Array.isArray(input.params) ? input.params : [])
      .filter((p) => p && typeof p.name === "string" && PARAM_NAME_RE.test(p.name.toLowerCase()))
      .map((p) => ({ name: p.name.toLowerCase(), description: p.description }));

    const existing = this.tools.get(name);
    this.tools.set(name, {
      name,
      description,
      lang: lang as CodeLang,
      code,
      params,
      createdAt: existing?.createdAt ?? this.now(),
      runCount: existing?.runCount ?? 0,
    });
    await this.persist();
    log.info("самописный инструмент сохранён", { name, lang, params: params.length });
    return { ok: true };
  }

  /** Удалить инструмент. */
  async remove(name: string): Promise<boolean> {
    const ok = this.tools.delete(String(name ?? "").toLowerCase());
    if (ok) await this.persist();
    return ok;
  }

  has(name: string): boolean {
    return this.tools.has(name.toLowerCase());
  }

  list(): DynamicTool[] {
    return [...this.tools.values()];
  }

  /** Подставить аргументы в шаблон → готовый код для code.run. */
  render(name: string, args: Record<string, unknown>): RenderResult {
    const tool = this.tools.get(name.toLowerCase());
    if (!tool) return { ok: false, error: `инструмент «${name}» не найден` };
    let code = tool.code;
    for (const p of tool.params) {
      const v = args?.[p.name];
      const value = v === undefined || v === null ? "" : String(v);
      // Защита от инъекции через аргумент (§6, обход гарда подстановкой): значение само
      // по себе не должно нести запрещённых конструкций (сеть/шелл/реестр/обфускация).
      const argLint = lintCode(tool.lang, value);
      if (!argLint.ok) {
        return { ok: false, error: `аргумент «${p.name}» отклонён гардом (§6): ${argLint.violations[0]?.message}` };
      }
      code = code.replace(PLACEHOLDER(p.name), value);
    }
    // runCount — диагностический, держим в памяти; НЕ персистим на каждый вызов
    // (write-амплификация). На диск уходит при create/remove.
    tool.runCount += 1;
    return { ok: true, lang: tool.lang, code };
  }

  /** Схемы инструментов для набора модели (§6): самописные становятся вызываемыми. */
  asToolSchemas(): ToolSchema[] {
    return this.list().map((t) => ({
      name: t.name,
      description: `[самописный] ${t.description} (lang=${t.lang})`,
      input_schema: {
        type: "object",
        properties: Object.fromEntries(
          t.params.map((p) => [p.name, { type: "string", description: p.description ?? p.name }]),
        ),
        // Параметры обязательны — иначе модель вызовет с пустыми подстановками.
        required: t.params.map((p) => p.name),
        additionalProperties: false,
      },
    }));
  }

  /** Сериализуем записи в одну цепочку — параллельные persist() не корёжат файл. */
  private writeChain: Promise<void> = Promise.resolve();

  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(() => this.doPersist());
    return this.writeChain;
  }

  /** Атомарная запись: tmp → rename, плюс .bak — битый файл не стирает выученные навыки. */
  private async doPersist(): Promise<void> {
    try {
      await mkdir(dirname(this.storePath), { recursive: true });
      const json = JSON.stringify(this.list(), null, 2);
      const tmp = `${this.storePath}.tmp`;
      await writeFile(tmp, json, "utf8");
      // Текущий файл → .bak (если есть), затем tmp → основной (атомарно для читателя).
      await rename(this.storePath, `${this.storePath}.bak`).catch(() => undefined);
      await rename(tmp, this.storePath);
    } catch (e) {
      log.warn("не удалось сохранить самописные инструменты", e instanceof Error ? e.message : String(e));
    }
  }
}

function err(message: string): CreateResult {
  return { ok: false, error: message };
}
