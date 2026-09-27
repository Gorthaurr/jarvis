// W3 (L-8): текст verify-нуджа с лестницей «глаз» под ту РУКУ, что действовала последней. Общие тексты — как были
// (контракт волны: тесты ловят нудж по их началу и по «лестнице §Волна3»). Ветка невидимого браузера отдельная:
// после web_act прежняя лестница звала browser_read/browser_inspect — это вкладки ВЛАДЕЛЬЦА в его Chrome, а не
// невидимая вкладка Джарвиса, где был клик; сверка там видела бы чужую страницу и снимала долг ложно.
import { isBlindMutate } from "../error-voice.js";

const LADDER_CLAIMED = "look{what:'elements'} (нативное окно) / browser_read / browser_inspect (веб) / look{what:'text'} (текст с canvas/игры) / screen_capture (последний резерв)";
const LADDER_PLAIN = "look{what:'elements'} (нативное окно) / browser_read / browser_inspect (веб) / look{what:'text'} (canvas/игра) / screen_capture (последний резерв)";
const LADDER_WEB =
  "web_read (текст ТВОЕЙ невидимой вкладки, где был web_act) / web_read{view:'elements'} или web_inspect (элементы, значения полей, состояние кнопок) — " +
  "глаза именно того браузера, в котором ты действовал; вкладки владельца тут ни при чём";

/** Последняя слепая «рука» задачи (без «(ошибка)»: упавший вызов долга не взводит), либо undefined. */
export function lastBlindHand(trajectory: readonly string[]): string | undefined {
  for (let i = trajectory.length - 1; i >= 0; i -= 1) {
    const entry = trajectory[i] ?? "";
    if (entry.endsWith("(ошибка)")) continue;
    const name = entry.split(" ")[0] ?? "";
    if (isBlindMutate(name)) return name;
  }
  return undefined;
}

/** Текст verify-нуджа: claimed — модель заявила наблюдаемый результат; лестница — по последней слепой руке. */
export function verifyNudgeText(claimed: boolean, trajectory: readonly string[]): string {
  const web = lastBlindHand(trajectory) === "web_act";
  return claimed
    ? `Стоп. Ты заявил результат, но НЕ сверил его глазами после последнего действия — мог выдумать. СВЕРЬ ФАКТОМ, дешёвое прежде дорогого (лестница §Волна3): ${web ? LADDER_WEB : LADDER_CLAIMED} — и убедись, что цель РЕАЛЬНО достигнута. Достигнута → подтверди тем, что реально увидел. НЕ достигнута → зайди другим способом и доведи. Содержимое не сочиняй.`
    : `Стоп. Ты сделал действие, но НЕ проверил исход — клик/ввод/команда могли не сработать (регион, нет элемента, потерян фокус). Прежде чем сказать «готово», СВЕРЬ РЕАЛЬНЫЙ результат дешёвым сенсором (лестница §Волна3): ${web ? LADDER_WEB : LADDER_PLAIN}. Цель достигнута → подтверди фактом, что увидел. НЕ достигнута → зайди другим способом и доведи, не сдавайся.`;
}
