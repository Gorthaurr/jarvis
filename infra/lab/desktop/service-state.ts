/**
 * Состояние сервисной группы «на прогон» + пути виртуальной ФС. Состояние привязано к ИДЕНТИЧНОСТИ `core.fs`: reset()
 * ядра создаёт новую виртуальную ФС, а значит и наши задания/страницы/заказы обнуляются вместе с ней (без хука reset).
 */
import { posix } from "node:path";
import { isProtectedSelfPathFast, isSecretPathFast } from "../../../apps/client/main/actuators/self-guard.js";
import { type DesktopCore, normPath } from "./core.js";

const stores = new WeakMap<object, Map<string, unknown>>();

export function runState<T>(core: DesktopCore, key: string, init: () => T): T {
  let m = stores.get(core.fs);
  if (!m) {
    m = new Map();
    stores.set(core.fs, m);
  }
  if (!m.has(key)) m.set(key, init());
  return m.get(key) as T;
}

/** Путь модели → нормализованный виртуальный (~ и относительные — от домашней папки, `..` схлопываются). */
export function vpath(core: DesktopCore, p: string): string {
  let s = String(p ?? "").trim().replace(/\\/gu, "/");
  if (s === "~" || s.startsWith("~/")) s = `${core.fs.home}${s.slice(1)}`;
  else if (!s.startsWith("/") && !/^[A-Za-z]:/u.test(s)) s = `${core.fs.home}/${s}`;
  const drive = /^([A-Za-z]:)(.*)$/u.exec(s);
  const norm = drive ? `${drive[1]}${posix.normalize(drive[2] || "/")}` : posix.normalize(s);
  return normPath(norm.length > 3 ? norm.replace(/\/$/u, "") : norm);
}

export const parentOf = (abs: string): string => abs.slice(0, Math.max(abs.lastIndexOf("/"), 0)) || "/";

/** Рельсы §0 как у настоящего клиента (те же функции self-guard): текст причины или null. */
export function pathDenial(abs: string, write: boolean): string | null {
  if (isSecretPathFast(abs)) return `защита секретов (§0): «${abs}» — секретный файл (ключи/креды/контейнер подписи), ${write ? "писать в него" : "читать его в контекст модели"} нельзя.`;
  if (write && isProtectedSelfPathFast(abs)) return `защита самосохранности (§): «${abs}» критичен для работы Джарвиса (node_modules / .env / запущенный бинарь) — менять нельзя.`;
  return null;
}

/** Записать байты в виртуальную ФС (родитель обязан существовать — проверяет вызывающий) + эффект fs.write. */
export function putFile(core: DesktopCore, abs: string, data: Buffer, via: string): { created: boolean } {
  const created = !core.fs.files.has(abs);
  core.fs.files.set(abs, data);
  core.effect("fs.write", { path: abs, bytes: data.length, created, via });
  return { created };
}

export const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

/** Секреты не попадают в журнал эффектов: значения ключей вида key/token/password/secret/cookie value → «***». */
export function redact(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(redact);
  if (o && typeof o === "object") {
    return Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, /key|token|pass|secret|cookie|value$/iu.test(k) ? "***" : redact(v)]));
  }
  return o;
}
