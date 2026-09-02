/**
 * Вкладка «Оплата» (§6B/B5) — вынесено из god-file renderer.ts (§ревью). Реальные данные расхода/лимитов:
 * подписка jarvis.onUsage + кнопка «Управление подпиской». jarvis — DI-аргумент.
 *
 * ЧЕСТНАЯ ВАЛЮТА (2026-09-02): SpendGuard считает в USD (obs/pricing), а вкладка печатала «₽» — ложь UI.
 * Теперь валюта — из `UsageInfo.currency` (отсутствует = USD, так было всегда) → «$1.23». Продуктовые
 * поля (кредиты/план/статус/порог) показываются, только если сервер их прислал; без них — прежний вид в $.
 * Чистые label-функции экспортированы ради теста без DOM (jsdom в клиенте нет).
 * Элементы #planName/#planBalance/#planNoteRow/#planNote/#manageBillingBtn — через getElementById (null-safe).
 */
import type { JarvisBridge } from "../main/ipc-contract.js";
import type { UsageInfo } from "@jarvis/protocol";

/** Статус подписки по-русски; active/none/неизвестный — без пометки (не выдумываем состояние). */
const STATUS_RU: Record<string, string> = {
  trialing: "пробный",
  past_due: "ждёт оплаты",
  expired: "истёк",
  canceled: "отменён",
};

/** Сумма в валюте бюджета: USD → «$1.23»; иная (на будущее) — «1.23 XXX», но НЕ «₽» по умолчанию. */
export function money(n: number, currency: string): string {
  return currency === "USD" ? `$${n.toFixed(2)}` : `${n.toFixed(2)} ${currency}`;
}

/** Срок («до 12.10.2026») из ISO; невалидная дата — пусто, а не «Invalid Date». */
function untilLabel(iso?: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return ` до ${new Date(t).toLocaleDateString("ru-RU")}`;
}

/** Строка тарифа: имя плана (planName главнее производной метки) + статус (+ срок) + аварийный стоп. */
export function planLabel(u: UsageInfo): string {
  const status = u.status ? STATUS_RU[u.status] : undefined;
  let out = u.planName ?? u.plan;
  if (status) out += ` · ${status}${untilLabel(u.periodEnd)}`;
  if (u.killSwitch) out += " (стоп)";
  return out;
}

/** Строка баланса: кредиты плана (продукт) либо расход/потолок в валюте (dev — как раньше, но честно в $). */
export function balanceLabel(u: UsageInfo): string {
  const cur = u.currency ?? "USD";
  if (u.credits) {
    const c = u.credits;
    // Процент — от ФАКТА (used/quota), а не из pct вслепую: контракт не закрепляет, «использовано» это
    // или «остаток», а неверный процент во вкладке денег — ложь владельцу. pct — лишь фолбэк при quota=0.
    const pctUsed = c.quota > 0 ? Math.round((c.used / c.quota) * 100) : c.pct;
    // Единица измерения приходит с сервера: голое «использовано 371 из 850» после оплаты 900 ₽ читается
    // как обман (живой прогон 2026-09-02) — показываем валюту и поясняем, что это расход на модель.
    const u1 = c.unit ? ` ${c.unit}` : "";
    const note = c.note ? ` · ${c.note}` : "";
    return `кредиты: использовано ${c.used}${u1} из ${c.quota}${u1} (остаток ${c.remaining}${u1}, ${pctUsed}% использовано) · ${u.period}${note}`;
  }
  return `${money(u.spent, cur)} из ${money(u.cap, cur)} · остаток ${money(u.remaining, cur)} · ${u.period}`;
}

/** Пометка о пороге (warn): 80 — предупреждение, 100 — лимит исчерпан; нет порога — пусто. */
export function warnLabel(u: UsageInfo): string {
  if (u.warn === "100") return "⚠ лимит периода исчерпан";
  if (u.warn === "80") return `⚠ израсходовано более ${u.softPct ?? 80}% лимита`; // порог — из плана, не хардкод
  return "";
}

export function initBillingPanel(jarvis: JarvisBridge): void {
  jarvis.onUsage((u) => {
    const planEl = document.getElementById("planName");
    const balEl = document.getElementById("planBalance");
    const noteRow = document.getElementById("planNoteRow");
    const noteEl = document.getElementById("planNote");
    if (planEl) planEl.textContent = planLabel(u);
    if (balEl) balEl.textContent = balanceLabel(u);
    const note = warnLabel(u);
    if (noteRow && noteEl) {
      noteEl.textContent = note;
      noteEl.classList.toggle("plan__value--warn", Boolean(note));
      noteRow.classList.toggle("plan__row--hidden", !note);
    }
  });
  // Кнопка «Управление подпиской» — обновляет данные. `checkoutUrl` НЕ открываем: у моста preload нет
  // openExternal (renderer изолирован, окно наружу не откроет), а заводить новый канал ради ссылки без
  // провайдера оплаты (§0-p5) — отдельное решение владельца.
  document.getElementById("manageBillingBtn")?.addEventListener("click", () => jarvis.requestUsage());
}
