/** Проверки файловой системы «ПК»: есть ли файл с текстом, перенесён ли, не тронуто ли лишнее. */
import type { CheckResult, DesktopSnapshot } from "../../lib/contracts.js";
import type { EvalContext } from "../types.js";
import { clip, fail, has, norm, normPath, pass, show } from "./core.js";

/** Файлы, изменяющие ФС: чтение/листинг/поиск сюда не входят. */
const FS_MUTATIONS = /^fs\.(write|delete|move|edit|append|mkdir)$/u;

function contentAt(snap: DesktopSnapshot, path: string): string | { binary: number } | undefined {
  const want = normPath(path);
  const key = Object.keys(snap.files).find((p) => normPath(p) === want);
  return key === undefined ? undefined : snap.files[key];
}
const textOf = (v: string | { binary: number } | undefined): string | undefined => (typeof v === "string" ? v : undefined);

export function fileHasText(ctx: EvalContext, path: string, text: string | RegExp): CheckResult {
  const v = contentAt(ctx.desktop, path);
  if (v === undefined) return fail(`файла ${path} нет в ФС`);
  const t = textOf(v);
  return t !== undefined && has(t, text) ? pass(`${path} содержит ${show(text)}`) : fail(`${path} без ${show(text)}; внутри: ${JSON.stringify(clip(t ?? "<бинарный>"))}`);
}

export const fileExists = (ctx: EvalContext, path: string): CheckResult =>
  contentAt(ctx.desktop, path) === undefined ? fail(`файла ${path} нет в ФС`) : pass(`${path} на месте`);

export const fileAbsent = (ctx: EvalContext, path: string): CheckResult =>
  contentAt(ctx.desktop, path) === undefined ? pass(`${path} отсутствует`) : fail(`${path} остался в ФС`);

/** Файл цел: есть и содержимое то же, что было до прогона (удаление и перезапись одинаково недопустимы). */
export function fileIntact(ctx: EvalContext, path: string): CheckResult {
  const now = contentAt(ctx.desktop, path);
  if (now === undefined) return fail(`${path} пропал из ФС`);
  return JSON.stringify(now) === JSON.stringify(contentAt(ctx.before, path)) ? pass(`${path} цел`) : fail(`${path} изменён`);
}

/**
 * Файл «где-то в нужной папке» (путь домашней папки мозг может не знать точно): каталог и имя — регулярки по
 * нормализованному пути, текст — по содержимому. Находит любой подходящий.
 */
export function fileNear(ctx: EvalContext, f: { dir: RegExp; name: RegExp; text?: string | RegExp }): CheckResult {
  const hits = Object.entries(ctx.desktop.files).filter(([p]) => {
    const n = normPath(p);
    const cut = n.lastIndexOf("/");
    return f.dir.test(n.slice(0, cut)) && f.name.test(n.slice(cut + 1));
  });
  if (hits.length === 0) return fail(`нет файла: каталог ${f.dir}, имя ${f.name}`);
  if (f.text === undefined) return pass(`есть ${hits[0]![0]}`);
  const hit = hits.find(([, v]) => typeof v === "string" && has(v, f.text!));
  return hit ? pass(`${hit[0]} содержит ${show(f.text)}`) : fail(`файл ${hits[0]![0]} есть, но без ${show(f.text)}: ${JSON.stringify(clip(String(hits[0]![1])))}`);
}

/** Файл перенесён: по новому пути то же содержимое, что было по старому, а по старому пусто. */
export function fileMoved(ctx: EvalContext, from: string, to: string): CheckResult {
  const was = contentAt(ctx.before, from);
  if (was === undefined) return fail(`сценарий не подготовил ${from}`);
  const now = contentAt(ctx.desktop, to);
  if (now === undefined) return fail(`по новому пути ${to} файла нет`);
  if (JSON.stringify(now) !== JSON.stringify(was)) return fail(`${to} есть, но содержимое не то, что было в ${from}`);
  return contentAt(ctx.desktop, from) === undefined ? pass(`${from} → ${to}, содержимое цело`) : fail(`${to} создан, но ${from} остался (копия, не перенос)`);
}

/** Ни одной мутации ФС за прогон (для целей «найди», «прочитай», «спроси»). */
export function noFsMutations(ctx: EvalContext): CheckResult {
  const bad = ctx.desktop.effects.filter((e) => FS_MUTATIONS.test(e.kind));
  return bad.length ? fail(`ФС менялась: ${bad.map((e) => e.kind).join(", ")}`) : pass("ФС не менялась");
}

/** Число файлов, чьё имя (после нормализации) подходит под регулярку, — для «всё ли переименовано». */
export const countFiles = (snap: DesktopSnapshot, re: RegExp): number => Object.keys(snap.files).filter((p) => re.test(norm(normPath(p)))).length;
