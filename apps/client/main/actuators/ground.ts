/**
 * Грундинг и UIA-паттерны через win-сайдкар (§6).
 *
 * Замковый камень (§6): цель резолвится по РОЛИ/ИМЕНИ в a11y-дереве (UIAutomation),
 * не по пикселям/DOM. ui.ground → handle+bbox; ui.invoke действует по handle через
 * UIA-паттерн (Invoke/SetValue/Select/Toggle/Expand/Scroll) БЕЗ захвата курсора и
 * фокуса — юзер продолжает работать, пока Джарвис действует в фоновом окне.
 *
 * Реальная UIA — в сайдкаре apps/sidecar-win (C#/.NET); связь по stdio JSON-RPC.
 * Если сайдкар не поднят — NotImplementedError (dispatch → runtime-ошибка).
 */
import type { Target, UiPattern } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import { NotImplementedError, ensureSidecar } from "./sidecar-ready.js";
import { sidecar } from "./sidecar-client.js";
import { injectRpc } from "./inject.js";
import { noteGround, noteSnapshot } from "./handle-mirror.js";

const log = createLogger("actuator:ground");

/** Результат ui.ground — в ActionResult.data (§5: {handle, bbox}); W2: + name/role элемента (сайдкар их отдаёт). */
export interface GroundResult {
  handle: string;
  /** ФИЗИЧЕСКИЕ пиксели (UIA BoundingRectangle). */
  bbox: { x: number; y: number; w: number; h: number };
  name?: string;
  /** Как отдаёт сайдкар: «ControlType.Button». */
  role?: string;
}

const ensure = (): void => ensureSidecar("сайдкар UIA не запущен");
/** W2: поколение сайдкара для зеркала handle (тестовые моки отдают только {ready, request}). */
const gen = (): number => (sidecar() as { generation?: number }).generation ?? 0;

/** Обход a11y-дерева сложного окна реально дольше дефолтных 5с — даём запас, чтобы не рвать на полпути. */
const UIA_TIMEOUT_MS = 12_000;

/**
 * Провалидировать ответ ground: handle обязателен, иначе действие ушло бы по undefined-handle.
 * W2: РЕАЛЬНАЯ форма сайдкара (Ipc.cs GroundResult) — ПЛОСКАЯ {handle, x, y, w, h, name, role}; прежний разбор читал
 * только `bbox`, и bbox всегда был нулевым — проверка «под точкой контейнер» (H-A1) в бою не срабатывала.
 * Вложенный `bbox` оставлен для старых моков.
 */
function asGroundResult(data: unknown): GroundResult {
  const d = data as { handle?: unknown; bbox?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }; x?: unknown; y?: unknown; w?: unknown; h?: unknown; name?: unknown; role?: unknown };
  // Сайдкар отдаёт handle ЧИСЛОМ (C# int) — нормализуем в строку (Target.handle: string). Раньше здесь
  // жёстко требовалась строка → ground ВСЕГДА бросал на числовом handle (латентный баг ui.invoke-по-handle).
  const rawHandle = typeof d?.handle === "number" ? String(d.handle) : d?.handle;
  if (typeof rawHandle !== "string" || !rawHandle) {
    throw new Error("ui.ground: элемент не найден (пустой handle от сайдкара)");
  }
  const b = d.bbox ?? { x: d.x, y: d.y, w: d.w, h: d.h };
  const ok = [b.x, b.y, b.w, b.h].every((n) => typeof n === "number" && Number.isFinite(n));
  const g: GroundResult = {
    handle: rawHandle,
    bbox: ok ? { x: b.x as number, y: b.y as number, w: b.w as number, h: b.h as number } : { x: 0, y: 0, w: 0, h: 0 },
    ...(typeof d.name === "string" ? { name: d.name } : {}),
    ...(typeof d.role === "string" ? { role: d.role } : {}),
  };
  noteGround(g, gen()); // W2: зеркало handle (читает рубеж П1/П2)
  return g;
}

/** Найти элемент по роли/имени в активном окне (a11y-first, §6). §Волна2 (2.4): nameMode="substring"
 *  — матч имени по вхождению; automationId — устойчивый id. Scope в сайдкаре: активное окно → фолбэк
 *  на весь рабочий стол. §Волна3 ревью (#6): scope="active" — ТОЛЬКО активное окно, без фолбэка на
 *  стол (для предусловий шага навыка — иначе чужое фоновое окно даёт ложный pass). */
export async function ground(query: {
  role: string;
  name?: string;
  nameMode?: "exact" | "substring";
  automationId?: string;
  scope?: "active";
}): Promise<GroundResult> {
  ensure();
  log.debug("ui.ground", query);
  return asGroundResult(
    await sidecar().request(
      "ground",
      { role: query.role, name: query.name, nameMode: query.nameMode, automationId: query.automationId, scope: query.scope },
      UIA_TIMEOUT_MS,
    ),
  );
}

/** §Волна2 (2.4): интерактивные элементы окна одним списком (set-of-marks) — дешёвые «глаза». */
export interface UiSnapshotItem {
  handle: number;
  role: string;
  name: string;
  automationId?: string | null;
  value?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface UiSnapshot {
  window: string;
  pid: number;
  items: UiSnapshotItem[];
  truncated: boolean;
}

/** §Волна2 (2.4): снапшот интерактивных элементов окна (pid не задан → активное окно). */
export async function uiSnapshot(pid?: number, maxItems?: number): Promise<UiSnapshot> {
  ensure();
  log.debug("ui.snapshot", { pid, maxItems });
  const data = (await sidecar().request("ui.snapshot", { pid, maxItems }, UIA_TIMEOUT_MS)) as UiSnapshot;
  if (!data || !Array.isArray(data.items)) throw new Error("ui.snapshot: сайдкар вернул пустой снапшот");
  noteSnapshot(data, gen()); // W2: зеркало handle (имя, роль, value, pid окна, bbox)
  return data;
}

/** §бесшумный-ввод: элемент под ТОЧКОЙ (логические virtual-desktop координаты, как у click) → handle
 *  actionable-предка. Даёт бесшумный клик «по пикселям» из screen_capture (ui.invoke по handle, без курсора).
 *  Бросает, если под точкой нет UIA-элемента (canvas/игра) — вызывающий деградирует на физ.клик. */
export async function groundAtPoint(logicalX: number, logicalY: number, timeoutMs = UIA_TIMEOUT_MS): Promise<GroundResult> {
  ensure();
  log.debug("ui.ground.at", { logicalX, logicalY });
  return asGroundResult(await sidecar().request("ground.at", { x: logicalX, y: logicalY }, timeoutMs));
}

/** Действие по UIA-паттерну над целью (основной путь, §6). Сайдкар действует по handle. */
export async function invoke(target: Target, pattern: UiPattern, value?: string): Promise<void> {
  ensure();
  log.debug("ui.invoke", { pattern });
  // setValue без значения → C# пишет пустую строку (молча ОЧИЩАЕТ поле). Очистка должна быть
  // ОСОЗНАННОЙ: требуем непустое value, иначе это потерянный токен/значение, а не «очисти».
  if (pattern === "setValue" && (value === undefined || value === "")) {
    throw new Error("ui.invoke setValue без значения — отказ (для очистки поля передай явное пустое намерение)");
  }
  let handle: string;
  if (target.by === "handle") handle = target.handle;
  else if (target.by === "role") handle = (await ground({ role: target.role, name: target.name })).handle;
  else throw new NotImplementedError("ui.invoke по координатам невозможен — нужен a11y-handle");
  await injectRpc("invoke", { handle, pattern, value }, UIA_TIMEOUT_MS); // W2: через рубеж инжекции
}

/** Прочитать выделение/окно (дейксис §19) через сайдкар (TextPattern / a11y-выжимка). */
export async function readContext(scope: "selection" | "active_window" | "screen"): Promise<string> {
  ensure();
  // Явный маппинг по ВСЕМ scope (раньше "screen" молча схлопывался в read.window — читалось не то).
  const op = scope === "selection" ? "read.selection" : scope === "screen" ? "read.screen" : "read.window";
  const data = (await sidecar().request(op, {}, UIA_TIMEOUT_MS)) as { text?: string };
  return data.text ?? "";
}
