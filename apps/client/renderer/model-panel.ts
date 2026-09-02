/**
 * Секция «Модель» в настройках «Общее» (требование владельца 2026-09-02: пользователь САМ выбирает модель,
 * на которой работает Джарвис). Два селекта: «по умолчанию» (дефолт ходов) и «сильная» (эскалация §7).
 *
 * ЧЕСТНОСТЬ: селекты показывают, что пользователь ПОПРОСИЛ; строка «Сейчас: …» — что РЕАЛЬНО применилось
 * на сервере (каталог + allowlist плана); отклонённый выбор виден с причиной, а не сбрасывается молча.
 * Источник каталога — сервер (`jarvis.onModelsCatalog`: приходит на коннекте и после сохранения). До его
 * прихода в селектах только «Авто» + сохранённый id сырой подписью — выбор не теряется и не подменяется.
 * jarvis — DI-аргумент (паттерн init<Панель>, как billing/memory-panel).
 */
import { $ } from "./dom.js";
import type { JarvisBridge } from "../main/ipc-contract.js";
import type { ModelChoice, ModelsCatalog } from "@jarvis/protocol";

const AUTO_LABEL = "Авто (по умолчанию сервера)";
/** Причина отказа по-русски; неизвестный код показываем как есть (не выдумываем). */
const REASON_RU: Record<string, string> = {
  unknown: "неизвестная модель",
  not_allowed: "недоступна на тарифе",
  unavailable: "тариф временно недоступен — работаю на моделях по умолчанию",
};
const SLOT_RU: Record<"primary" | "strong", string> = { primary: "по умолчанию", strong: "сильная" };

export interface ModelPanel {
  /** Текущий выбор из селектов — для сохранения вместе с остальными настройками («» = авто). */
  choice(): ModelChoice;
  /** Выставить сохранённый выбор (при загрузке настроек). */
  setChoice(c: ModelChoice | undefined): void;
}

/** Опция для id, которого нет среди <option> (каталог ещё не пришёл / id вне каталога): сырой id как подпись. */
function ensureOption(select: HTMLSelectElement, id: string): void {
  if (!id) return;
  if (Array.from(select.options).some((o) => o.value === id)) return;
  const opt = document.createElement("option");
  opt.value = id;
  opt.textContent = `${id} (нет в каталоге)`;
  select.appendChild(opt);
}

function setValue(select: HTMLSelectElement, id: string | undefined): void {
  const v = (id ?? "").trim().toLowerCase();
  ensureOption(select, v);
  select.value = v;
}

/** Перестроить <option> селекта из каталога; недоступные на тарифе — disabled с пометкой. */
function rebuild(select: HTMLSelectElement, m: ModelsCatalog, keep: string): void {
  while (select.firstChild) select.removeChild(select.firstChild);
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = AUTO_LABEL;
  select.appendChild(auto);
  const allowed = m.allowed ? new Set(m.allowed) : null;
  for (const row of m.catalog) {
    const opt = document.createElement("option");
    opt.value = row.id;
    const blocked = allowed !== null && !allowed.has(row.id);
    opt.disabled = blocked;
    opt.textContent = blocked ? `${row.label} — недоступна на тарифе` : row.label;
    select.appendChild(opt);
  }
  setValue(select, keep);
}

export function initModelPanel(jarvis: JarvisBridge): ModelPanel {
  const primarySel = $<HTMLSelectElement>("modelPrimary");
  const strongSel = $<HTMLSelectElement>("modelStrong");
  const effectiveEl = $("modelEffective");
  const rejectedEl = $("modelRejected");
  let labels = new Map<string, string>();
  const labelOf = (id: string): string => labels.get(id) ?? id;

  jarvis.onModelsCatalog((m) => {
    labels = new Map(m.catalog.map((r) => [r.id, r.label]));
    // Сервер — источник истины о СОХРАНЁННОМ выборе: перестраиваем селекты под каталог и выставляем chosen.
    rebuild(primarySel, m, m.chosen.primary ?? "");
    rebuild(strongSel, m, m.chosen.strong ?? "");
    effectiveEl.textContent = `Сейчас: ${labelOf(m.effective.primary)} / ${labelOf(m.effective.strong)}`;
    const notes: string[] = [];
    if (m.rejected.length > 0) {
      notes.push("Не применилось: " + m.rejected.map((r) => `${SLOT_RU[r.slot]} — ${labelOf(r.id)} (${REASON_RU[r.reason] ?? r.reason})`).join("; ") + ".");
    }
    if (m.downgrade) notes.push("Сильная модель дешевле основной — эскалация на неё ответ не усилит.");
    // Схлопнутая лестница: сервер это знал и логировал, но пользователю не говорил (живой прогон 2026-09-02).
    if (m.collapsed) notes.push("Основная и сильная модель совпадают — на сложных задачах усиления не будет.");
    rejectedEl.textContent = notes.join(" ");
    rejectedEl.hidden = notes.length === 0;
  });

  return {
    choice: () => ({ primary: primarySel.value, strong: strongSel.value }),
    setChoice: (c) => {
      setValue(primarySel, c?.primary);
      setValue(strongSel, c?.strong);
    },
  };
}
