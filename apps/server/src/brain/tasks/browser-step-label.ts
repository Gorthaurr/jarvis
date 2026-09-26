/**
 * W1 «браузерные руки»: метка чипа §20 «что делаю сейчас» для рук во вкладке — по интенту/операции, а не одним
 * «Действую на странице» на всё (жалоба владельца «не видно, что делает»). Чистая функция.
 * 🔴 Значения полей (value/text у set/type) в метку НЕ попадают: чип виден на экране, а в поле мог уйти личный текст.
 */

/** Поля вызова: новая схема — на верхнем уровне, прежняя и шаги берста — в `params` (верхний уровень главнее). */
function fields(input: Record<string, unknown>): Record<string, unknown> {
  const p = input.params && typeof input.params === "object" ? (input.params as Record<string, unknown>) : {};
  return { ...p, ...input };
}

const ACT_LABELS: Record<string, string> = {
  click: "Нажимаю на странице",
  type: "Печатаю на странице",
  select: "Выбираю в списке",
  hover: "Навожу на элемент",
  scroll_to: "Прокручиваю к элементу",
  scroll: "Листаю страницу",
  seek: "Перематываю",
  back: "Назад по истории",
  forward: "Вперёд по истории",
  enter: "Жму Enter на странице",
  submit: "Отправляю форму",
  feed_auto: "Листаю ленту",
};

function steps(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return `${n} шаг`;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return `${n} шага`;
  return `${n} шагов`;
}

/** Метка браузерного вызова; null — не браузерный инструмент (решает общий stepLabelFor). */
export function browserStepLabel(toolName: string, input: Record<string, unknown>): string | null {
  const f = fields(input);
  const s = (v: unknown): string => String(v ?? "").trim();
  switch (toolName) {
    case "browser_act": {
      const intent = s(f.intent);
      if (intent === "set") return f.checked !== undefined ? "Отмечаю на странице" : "Заполняю поле";
      if (intent === "key") {
        const combo = s(f.combo ?? f.key);
        return `Нажимаю ${/^[\w+ -]{1,20}$/u.test(combo) ? combo : "клавишу"}`;
      }
      return ACT_LABELS[intent] ?? "Действую на странице";
    }
    case "browser_batch": {
      const n = Array.isArray(f.steps) ? f.steps.length : 0;
      return n > 0 ? `Действую на странице: ${steps(n)}` : "Действую на странице";
    }
    case "browser_read":
      if (s(f.view) === "image") return f.ref !== undefined || f.rect !== undefined ? "Рассматриваю элемент" : "Смотрю на вкладку";
      return "Читаю страницу";
    case "browser_inspect": {
      const q = s(f.query);
      return q ? `Ищу на странице: «${q.slice(0, 30)}»` : "Изучаю страницу";
    }
    case "browser_tabs":
      return s(f.op) === "close" ? "Закрываю вкладку" : "Смотрю вкладки";
    case "browser_close":
      return "Закрываю вкладку";
    default:
      return null;
  }
}
