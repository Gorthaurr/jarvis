/**
 * Живая волна голоса (дизайн §21) — вынесено из god-file renderer.ts (§ревью). Чистая идемпотентная
 * фабрика DOM по #wave: столбики-эквалайзер с огибающей sin, независимая пульсация (CSS animation:eq).
 * Инлайном — ТОЛЬКО геометрия конкретного столбика (ширина/высота/тайминг фазы); внешний вид
 * (цвет/свечение/скругление) и контейнер — в styles.css (.hero__wave/.hero__bar), иначе инлайн
 * перебивал state-правила (.hero--thinking .hero__wave{display:none} — волна торчала в «Думаю»).
 * Зависит ТОЛЬКО от document — ни renderer-состояния, ни jarvis-моста → импортируется обратно односторонне.
 */
export function buildWave(): void {
  const el = document.getElementById("wave");
  if (!el) return;
  el.replaceChildren();
  const N = 24;
  const W_MIN = 2; // геометрия «слушаю» из макета (n=24, w 2–3, высота до 50)
  const W_MAX = 3;
  const MAX_H = 50;
  for (let i = 0; i < N; i += 1) {
    const t = (i + 0.5) / N;
    const env = 0.24 + 0.76 * Math.sin(t * Math.PI);
    const h = Math.max(5, env * MAX_H);
    const w = W_MIN + (W_MAX - W_MIN) * Math.sin(t * Math.PI);
    const dur = (0.62 + (i % 6) * 0.12).toFixed(2);
    const delay = (-(i * 0.097) % 1.4).toFixed(2);
    const bar = document.createElement("span");
    bar.className = "hero__bar";
    bar.style.cssText =
      `width:${w.toFixed(1)}px;height:${h.toFixed(1)}px;` +
      `animation:eq ${dur}s ease-in-out ${delay}s infinite`;
    el.appendChild(bar);
  }
}
