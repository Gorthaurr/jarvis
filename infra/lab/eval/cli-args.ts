/**
 * Разбор аргументов CLI eval. Отдельно от запуска, чтобы юниты проверяли отказы без процессов: главный из них — real без
 * `--yes-spend` (это тратит общий лимит подписки владельца) отказывает ДО подъёма сервера.
 */
export interface EvalArgs {
  brain: "off" | "real";
  yesSpend: boolean;
  n: number;
  filter?: string;
  tag?: string;
  list: boolean;
  control: boolean;
  label?: string;
  json: boolean;
  write: boolean;
}

export const USAGE = `eval лаборатории Джарвиса:
  node --import tsx infra/lab/eval/cli.ts [--brain off|real] [--n N] [--filter текст] [--tag тег] [--list] [--control]
                                          [--label метка] [--json] [--no-write] [--yes-spend]
  --brain off    (по умолчанию) без модели: гоняет только то, что закрывает tier0 ($0); бесплатно
  --control      с off: гнать и остальные сценарии как отрицательный контроль (без мозга цель обязана НЕ достигаться)
  --brain real   настоящий мозг по подписке владельца; требует --yes-spend
  --list         показать сценарии и выйти          --no-write   не писать docs/lab/runs/eval-<метка>.{md,json}`;

const VALUE_FLAGS = new Set(["brain", "n", "filter", "tag", "label"]);
const BOOL_FLAGS = new Set(["yes-spend", "list", "control", "json", "no-write"]);

export function parseEvalArgs(argv: readonly string[]): { ok: true; args: EvalArgs } | { ok: false; error: string } {
  const raw: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (!a.startsWith("--")) return { ok: false, error: `лишний аргумент «${a}»` };
    const name = a.slice(2);
    if (BOOL_FLAGS.has(name)) raw[name] = true;
    else if (VALUE_FLAGS.has(name)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return { ok: false, error: `флагу ${a} нужно значение` };
      raw[name] = v;
      i += 1;
    } else return { ok: false, error: `неизвестный флаг ${a}` };
  }
  const brain = (raw.brain as string | undefined) ?? "off";
  if (brain !== "off" && brain !== "real") return { ok: false, error: `--brain ${brain}: допустимо off|real (сценарный мозг в лаборатории не подключается: у сервера нет шва подмены LLM)` };
  const n = raw.n === undefined ? 1 : Number(raw.n);
  if (!Number.isInteger(n) || n < 1 || n > 50) return { ok: false, error: `--n ${String(raw.n)}: нужно целое 1..50` };
  if (raw.control && brain !== "off") return { ok: false, error: "--control имеет смысл только с --brain off" };
  return {
    ok: true,
    args: {
      brain, yesSpend: raw["yes-spend"] === true, n, list: raw.list === true, control: raw.control === true, json: raw.json === true, write: raw["no-write"] !== true,
      ...(typeof raw.filter === "string" ? { filter: raw.filter } : {}), ...(typeof raw.tag === "string" ? { tag: raw.tag } : {}), ...(typeof raw.label === "string" ? { label: raw.label } : {}),
    },
  };
}

/** Причина отказа запускать (null — можно). real тратит подписку владельца, поэтому без явного согласия не стартует. */
export function spendRefusal(a: EvalArgs): string | null {
  if (a.brain !== "real" || a.yesSpend || a.list) return null;
  return "ОТКАЗ: --brain real идёт через настоящий мозг по подписке Max владельца и тратит его общий лимит (тот же, что у живого Джарвиса и Claude Code). Добавь --yes-spend, если это осознанно; сузь набор через --filter/--tag и --n, чтобы потратить минимум. Бесплатный вариант — --brain off.";
}
