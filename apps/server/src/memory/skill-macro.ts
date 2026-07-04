/**
 * §8 МАКРОС: компиляция успешной GUI-траектории задачи в детерминированные реплей-шаги навыка.
 *
 * Жалоба владельца: «понял процесс — почему не может просто написать себе макрос, чтобы потом
 * мгновенно?» Выученный навык — проза (LLM следует ей раунд за раундом, ~15с/раунд). Этот модуль
 * механически (без LLM) превращает ЖЕСТЫ успешного прогона (фокус/клики/клавиши) в машинные
 * строки грамматики parseSkillMd — они дописываются в навык секцией «## Шаги (реплей)», парсятся
 * в SkillStep[] при сохранении и на следующем recall исполняются клиентским skill-runner'ом за
 * секунды и $0. Провал реплея — честный откат на полную LLM-процедуру.
 *
 * Решения (осознанные):
 *  - app_launch НЕ компилируем: запуск гонится с загрузкой приложения (клики по лоадскрину).
 *    Макрос предполагает ЗАПУЩЕННОЕ приложение: начинается с app.focus — не запущено → focus
 *    честно падает → эскалация на LLM-процедуру (она запускает и ждёт меню).
 *  - Клики пишутся в АБСОЛЮТНЫХ экранных координатах (space="screen", клиент вернул разрешённые
 *    DIP в data) — реплей не зависит от маппинга последнего скрина. Клик без разрешённых координат
 *    (handle/role или старый клиент) → макрос НЕ компилируем (неполный макрос опасен).
 *  - После клика/клавиш — wait: даём UI перерисоваться (auto-wait по expect для игр недоступен —
 *    UIA слепа, visual-expect локально не проверяется).
 *  - Шаги слепые (без expect) → финальную сверку результата делает LLM одним раундом
 *    (screen_capture) — честность «клик ≠ результат» сохранена.
 */

/** Жест успешного прогона: имя инструмента + вход модели + данные результата актуатора. */
export interface GestureEvent {
  name: string;
  input: Record<string, unknown>;
  data?: unknown;
}

/** Заголовок секции реплея в procedure навыка (маркер для замены при повторной компиляции). */
export const REPLAY_SECTION_HEADER = "## Шаги (реплей — авто-макрос)";

const CLICK_SETTLE_MS = 800;
const KEY_SETTLE_MS = 400;
const FOCUS_SETTLE_MS = 500;

/** Экранирование значения атрибута (зеркало unescapeAttr в skills.ts). */
function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Скомпилировать жесты в машинные строки шагов. Пусто — макрос не собрать
 * (нет жестов ввода / клик без разрешённых координат / меньше 2 действий).
 */
export function compileReplayLines(trace: readonly GestureEvent[]): string[] {
  const lines: string[] = [];
  let gestures = 0; // реальные действия ввода (клик/клавиши/текст) — без них макрос бессмыслен

  for (const ev of trace) {
    switch (ev.name) {
      case "app_focus": {
        const app = String(ev.input.app ?? "").trim();
        if (!app) break;
        lines.push(`app.focus app="${esc(app)}"`);
        lines.push(`wait ms=${FOCUS_SETTLE_MS}`);
        break;
      }
      case "input_click": {
        const d = ev.data as { screenX?: unknown; screenY?: unknown } | undefined;
        const x = typeof d?.screenX === "number" ? d.screenX : null;
        const y = typeof d?.screenY === "number" ? d.screenY : null;
        // Клик без разрешённых экранных координат (handle/role-цель) в макрос не переносится,
        // а частичный макрос хуже отсутствующего — отменяем компиляцию целиком.
        if (x === null || y === null) return [];
        const method = ev.input.method === "physical" ? ` method="physical"` : "";
        lines.push(`input.click x=${Math.round(x)} y=${Math.round(y)} space="screen"${method}`);
        lines.push(`wait ms=${CLICK_SETTLE_MS}`);
        gestures += 1;
        break;
      }
      case "input_key": {
        const combo = String(ev.input.combo ?? "").trim();
        if (!combo) break;
        lines.push(`input.key combo="${esc(combo)}"`);
        lines.push(`wait ms=${KEY_SETTLE_MS}`);
        gestures += 1;
        break;
      }
      case "input_type": {
        const text = String(ev.input.text ?? "");
        if (!text) break;
        lines.push(`input.type text="${esc(text)}"`);
        lines.push(`wait ms=${KEY_SETTLE_MS}`);
        gestures += 1;
        break;
      }
      default:
        // Скрины/код/веб и прочее — глаза и мысли модели, в реплей не входят.
        break;
    }
  }

  if (gestures < 1 || lines.length < 2) return [];
  return lines;
}

/**
 * Вписать (или заменить) секцию реплея в procedure навыка. Возвращает НОВЫЙ текст процедуры;
 * если реплей уже там в том же виде — исходный текст (вызывающий не бампает версию).
 */
export function attachReplaySection(procedure: string, lines: readonly string[]): string {
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
  const section =
    `${REPLAY_SECTION_HEADER}\n` +
    `<!-- Сгенерировано автоматически из последнего УСПЕШНОГО прогона. Исполняется детерминированно\n` +
    `     skill-runner'ом ($0, секунды) ДО LLM-процедуры; предполагает запущенное приложение.\n` +
    `     Реплей слепой — результат сверяется глазами после него. Не редактировать вручную. -->\n` +
    `${numbered}`;

  const existing = extractReplayBlock(procedure);
  if (existing !== null) {
    const replaced = procedure.replace(existing, section);
    return replaced === procedure ? procedure : replaced;
  }
  return `${procedure.trimEnd()}\n\n${section}\n`;
}

/** Найти текущий блок реплея (от заголовка до следующего "## " или конца). null — нет. */
function extractReplayBlock(procedure: string): string | null {
  const start = procedure.indexOf(REPLAY_SECTION_HEADER);
  if (start < 0) return null;
  const rest = procedure.slice(start + REPLAY_SECTION_HEADER.length);
  const next = rest.search(/\n## /u);
  const end = next < 0 ? procedure.length : start + REPLAY_SECTION_HEADER.length + next;
  return procedure.slice(start, end).trimEnd();
}
