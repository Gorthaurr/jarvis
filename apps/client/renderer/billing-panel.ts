/**
 * Вкладка «Оплата» (§6B/B5) — вынесено из god-file renderer.ts (§ревью). Реальные данные расхода/лимитов
 * (раньше статика «Pro»/«—»): подписка jarvis.onUsage + кнопка «Управление подпиской». jarvis — DI-аргумент.
 * Элементы #planName/#planBalance/#manageBillingBtn — через getElementById (null-safe, как в оригинале).
 */
import type { JarvisBridge } from "../main/ipc-contract.js";

export function initBillingPanel(jarvis: JarvisBridge): void {
  // §6B/B5 «Оплата»: реальные данные расхода/лимитов (раньше статика «Pro»/«—»).
  jarvis.onUsage((u) => {
    const fmt = (n: number) => `${n.toFixed(2)} ₽`;
    const planEl = document.getElementById("planName");
    const balEl = document.getElementById("planBalance");
    if (planEl) planEl.textContent = u.killSwitch ? `${u.plan} (стоп)` : u.plan;
    if (balEl) balEl.textContent = `${fmt(u.spent)} из ${fmt(u.cap)} · остаток ${fmt(u.remaining)} · ${u.period}`;
  });
  // Кнопка «Управление подпиской» — пока обновляет данные (реальной платёжной системы нет, §0-p5).
  document.getElementById("manageBillingBtn")?.addEventListener("click", () => jarvis.requestUsage());
}
