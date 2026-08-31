/**
 * Вкладка «Память» (волна E, идея Skales — единственное место, где их память была лучше нашей):
 * владелец ВИДИТ всё, что Джарвис о нём накопил, и точечно забывает. До этого память была невидима,
 * править её можно было только голосом («забудь, что…»).
 *
 * Три слоя показываются РАЗДЕЛЬНО и с тем же провенансом, что в промпте (иначе владелец правил бы не то):
 *   • «Точные факты» — курируемые факты профиля; идут в промпт как ASSERTED;
 *   • «Всплывает из разговоров» — эпизодическая память; в промпте ХЕДЖИРОВАНА («возможно… сверься»);
 *   • «Вытеснено» — архив вытесненных капом; в промпт НЕ идёт, забывать нечего (витрина честности).
 * Забывание МЯГКОЕ (эпизод → stale, факт убирается из профиля) — как и голосовой memory_forget.
 * jarvis — DI-аргумент (паттерн init<Панель>, как billing/task-panel).
 */
import { $ } from "./dom.js";
import { buildListItem } from "./list-item.js";
import type { JarvisBridge } from "../main/ipc-contract.js";
import type { MemoryConsolidationRun, MemoryItem, MemoryState } from "@jarvis/protocol";

/** Человеческая дата записи («12 мар, 14:03»); без времени — пусто (у фактов профиля его нет). */
function whenLabel(ts?: number): string | undefined {
  if (ts === undefined || !Number.isFinite(ts)) return undefined;
  try {
    return new Date(ts).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return undefined;
  }
}

/**
 * F3 (волна F): человеческая метка провенанса — ОТКУДА запись взялась. Неизвестный/легаси source
 * не показываем вовсе (не выдумываем «неизвестно откуда» за данные).
 */
// Категории «вы сами» тут НЕТ: писать память напрямую владелец пока не может (см. MemorySource) —
// объявить недостижимую категорию максимального доверия значило бы соврать в витрине честности.
const SOURCE_RU: Record<string, string> = {
  model: "записал в разговоре",
  reflex: "рефлекс из реплики",
  consolidation: "сон-цикл",
};
function sourceLabel(source?: string): string | undefined {
  return source ? SOURCE_RU[source] : undefined;
}

/** Отрисовать один слой в <ul>; onForget=null → слой только для чтения (архив вытесненных). */
function renderLayer(
  list: HTMLUListElement | null,
  items: MemoryItem[],
  emptyText: string,
  onForget: ((item: MemoryItem) => void) | null,
  hasMore = false,
): void {
  if (!list) return;
  list.innerHTML = "";
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "skill-list__empty";
    li.textContent = emptyText;
    list.appendChild(li);
    return;
  }
  for (const item of items) {
    const sub = [item.kind, whenLabel(item.ts), sourceLabel(item.source)].filter(Boolean).join(" · ");
    list.appendChild(
      buildListItem({
        name: item.text,
        ...(sub ? { sub } : {}),
        action: onForget
          ? { label: "Забыть", variant: "ghost", onClick: () => onForget(item) }
          : // Архив вытесненного: кнопки действия нет — но buildListItem её требует, поэтому
            // рисуем неактивную метку «в архиве» (честно: тут нечего забывать, оно уже вне промпта).
            { label: "в архиве", variant: "ghost", onClick: () => undefined },
      }),
    );
  }
  // ЧЕСТНОСТЬ (адверс-ревью): показанное ≠ всё накопленное. Без этой строки владелец читал список
  // как исчерпывающий — и делал вывод «вот всё, что Джарвис обо мне знает».
  if (hasMore) {
    const li = document.createElement("li");
    li.className = "skill-list__empty";
    li.textContent = "…показаны только самые свежие — записей больше. Уточните поиском.";
    list.appendChild(li);
  }
}

/**
 * F3 (волна F): журнал сон-цикла — «что фоновая консолидация реально записала» (аналог Dream Diary).
 * Только чтение: прогон — событие, забывать нечего (сами факты забываются в слоях выше).
 */
function renderConsolidation(list: HTMLUListElement | null, runs: MemoryConsolidationRun[]): void {
  if (!list) return;
  list.innerHTML = "";
  if (runs.length === 0) {
    const li = document.createElement("li");
    li.className = "skill-list__empty";
    li.textContent = "Сон-цикл ещё ничего не записывал.";
    list.appendChild(li);
    return;
  }
  for (const run of runs) {
    const li = document.createElement("li");
    li.className = "skill-list__empty";
    const when = whenLabel(run.ts) ?? "";
    const dropped = run.dropped > 0 ? `, отброшено фильтром: ${run.dropped}` : "";
    // Контроль-2: «извлечено» считается ДО фильтра и дневного лимита, поэтому остаток между
    // extracted и written+dropped надо объяснить, а не оставлять владельца гадать.
    const rest = run.extracted - run.written - run.dropped;
    const restNote = rest > 0 ? `, ещё ${rest} — дубли известного или сверх дневного лимита` : "";
    const facts = run.facts.length > 0 ? ` — ${run.facts.join("; ")}` : "";
    li.textContent = `${when}: записано ${run.written} из ${run.extracted}${dropped}${restNote}${facts}`;
    list.appendChild(li);
  }
}

export function initMemoryPanel(jarvis: JarvisBridge): void {
  const factsList = $<HTMLUListElement>("memFactsList");
  const episodesList = $<HTMLUListElement>("memEpisodesList");
  const evictedList = $<HTMLUListElement>("memEvictedList");
  const search = $<HTMLInputElement>("memSearch");
  const counts = $<HTMLElement>("memCounts");
  const warn = $<HTMLElement>("memWarn");

  jarvis.onMemory((m: MemoryState) => {
    // Текст пустоты выбираем по ЭХО СЕРВЕРА (какой фильтр он реально применил), а не по локальному
    // флагу: тот расходился с реальностью после «Забыть» и при гонке быстрого ввода (адверс-ревью).
    const applied = m.query ?? "";
    const empty = (what: string) => (applied ? "По запросу ничего не найдено." : what);
    renderLayer(factsList, m.facts, empty("Точных фактов пока нет."), (it) => jarvis.forgetMemory("fact", it.id, applied || undefined));
    renderLayer(
      episodesList,
      m.episodes,
      empty("Записей из разговоров пока нет."),
      (it) => jarvis.forgetMemory("episode", it.id, applied || undefined),
      m.hasMore?.episodes === true,
    );
    renderLayer(evictedList, m.evicted, empty("Ничего не вытеснялось."), null, m.hasMore?.evicted === true);
    renderConsolidation($<HTMLUListElement>("memConsolidationList"), m.consolidation ?? []);
    if (counts) {
      // Числа честные: где показанное усечено — говорим «200+», а не выдаём кап за полный объём.
      // «—», когда чтения НЕ БЫЛО (totals не пришёл и усечения нет): ноль здесь означал бы
      // «Джарвис ничего не помнит», хотя записи есть, но прочитать их не удалось.
      const ep = m.hasMore?.episodes === true
        ? `${m.episodes.length}+`
        : m.totals?.episodes !== undefined
          ? String(m.totals.episodes)
          : "—";
      const ev = m.totals?.evicted !== undefined && m.totals.evicted > m.evicted.length ? `${m.evicted.length} из ${m.totals.evicted}` : String(m.evicted.length);
      counts.textContent = `Фактов: ${m.facts.length} · из разговоров: ${ep} · вытеснено: ${ev}`;
    }
    if (warn) {
      // ЧЕСТНОСТЬ: «не смог прочитать» ≠ «памяти нет» — иначе владелец решит, что Джарвис его забыл.
      warn.textContent = m.episodesUnavailable ?? "";
      warn.classList.toggle("memwarn--hidden", !m.episodesUnavailable);
    }
  });

  // Поиск с дебаунсом: фильтрация делается НА СЕРВЕРЕ (там вся память), UI лишь шлёт подстроку.
  let timer: ReturnType<typeof setTimeout> | undefined;
  search?.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => jarvis.requestMemory(search.value.trim() || undefined), 250);
  });
}
