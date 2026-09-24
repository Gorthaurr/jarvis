/**
 * Вставка текста через буфер обмена (ревью 2026-09-24, H-T1): посимвольная печать идёт ~130–150 мс на символ,
 * и сообщение в 300+ символов не укладывалось в бюджет act (45 с) — сервер объявлял таймаут, клиент ДОПЕЧАТЫВАЛ,
 * модель повторяла → текст в поле дважды, в худшем случае двойная отправка. Длинный текст вставляем мгновенно:
 * Ctrl+V с подменой буфера и ВОЗВРАТОМ прежнего содержимого (буфер владельца не теряем).
 */
import { clipboard } from "electron";
import { pressKey } from "./input.js";

/** С какой длины текст вставляется, а не печатается (короткий — печатаем: так ведут себя поля с автодополнением). */
export const PASTE_FROM_CHARS = 80;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function pasteText(text: string): Promise<void> {
  const prev = clipboard.readText();
  clipboard.writeText(text);
  try {
    await pressKey("Ctrl+V");
    await sleep(150); // приложение забирает буфер асинхронно — вернуть прежний раньше значит вставить старый
  } finally {
    clipboard.writeText(prev);
  }
}
