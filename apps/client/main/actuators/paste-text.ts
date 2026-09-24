/**
 * Вставка текста через буфер обмена (ревью 2026-09-24, H-T1): посимвольная печать идёт ~130–150 мс на символ,
 * и сообщение в 300+ символов не укладывалось в бюджет act (45 с) — сервер объявлял таймаут, клиент ДОПЕЧАТЫВАЛ,
 * модель повторяла → текст в поле дважды, в худшем случае двойная отправка. Длинный текст вставляем мгновенно:
 * Ctrl+V с подменой буфера и ВОЗВРАТОМ прежнего содержимого.
 *
 * Контроль-1 №6: первая версия сохраняла только `readText()` — скриншот (Win+Shift+S) в буфере владельца стирался,
 * а 150 мс ожидания мало для занятого Electron-окна (Discord/Telegram): Ctrl+V обрабатывался ПОСЛЕ возврата, и в поле
 * сообщения уходил прежний буфер (возможно, скопированный пароль). Теперь: снимок всех форматов, которые умеем вернуть
 * (текст, HTML, RTF, картинка); буфер с чем-то ещё (скопированные файлы и т.п.) не трогаем — печатаем посимвольно.
 */
import { clipboard, type NativeImage } from "electron";
import { pressKey, typeText } from "./input.js";

/** С какой длины текст вставляется, а не печатается (короткий — печатаем: так ведут себя поля с автодополнением). */
export const PASTE_FROM_CHARS = 80;

/** Сколько ждём после Ctrl+V, прежде чем вернуть буфер: приложение забирает его асинхронно. */
export const PASTE_SETTLE_MS = 400;

/** Форматы, которые умеем вернуть на место (Electron: availableFormats отдаёт MIME-подобные имена). */
const RESTORABLE_FORMAT_RE = /^(text\/plain|text\/html|text\/rtf|image\/[\w.+-]+)$/iu;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ClipSnapshot {
  text: string;
  html: string;
  rtf: string;
  image?: NativeImage;
}

/** Снимок буфера или null, если в нём есть то, что вернуть нельзя (тогда буфер не трогаем вовсе). */
export function snapshotClipboard(): ClipSnapshot | null {
  const formats = clipboard.availableFormats();
  if (!formats.every((f) => RESTORABLE_FORMAT_RE.test(f))) return null;
  const img = clipboard.readImage();
  return { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), ...(img.isEmpty() ? {} : { image: img }) };
}

function restoreClipboard(s: ClipSnapshot): void {
  const data: { text?: string; html?: string; rtf?: string; image?: NativeImage } = {};
  if (s.text) data.text = s.text;
  if (s.html) data.html = s.html;
  if (s.rtf) data.rtf = s.rtf;
  if (s.image) data.image = s.image;
  if (Object.keys(data).length === 0) clipboard.clear();
  else clipboard.write(data);
}

/**
 * Вставить текст в поле с фокусом. Буфер владельца возвращается целиком; вернуть нельзя — печатаем посимвольно
 * (медленнее, но ничего чужого не теряем). Возвращает, каким путём ушёл текст.
 */
export async function pasteText(text: string): Promise<"paste" | "type"> {
  const prev = snapshotClipboard();
  if (!prev) {
    await typeText(text);
    return "type";
  }
  clipboard.writeText(text);
  try {
    await pressKey("Ctrl+V");
    await sleep(PASTE_SETTLE_MS);
  } finally {
    restoreClipboard(prev);
  }
  return "paste";
}
