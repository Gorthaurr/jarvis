/**
 * S-12 (W4): чьё расширение пускаем на /ext.
 *
 * ID распакованного расширения Chrome ДЕТЕРМИНИРОВАН полем `key` в `apps/extension/manifest.json`
 * (первые 16 байт sha256 от DER-ключа, цифры 0-f → буквы a-p). Раньше без `JARVIS_EXT_ID` канал принимал
 * ЛЮБОЕ `chrome-extension://…` — а он отдаёт `cookies.export` (все куки расшифрованными) и `telegram.send`.
 * Теперь пиннинг есть всегда: по умолчанию — ID нашего ключа; `JARVIS_EXT_ID` остаётся ПЕРЕОПРЕДЕЛЕНИЕМ
 * (расширение с другим ключом), режима «любое расширение» нет. Константу сверяет с манифестом тест.
 */
import { createHash } from "node:crypto";

/** ID «Jarvis Web Hands» из `key` манифеста (pjkela…ajd). */
export const JARVIS_WEB_HANDS_EXT_ID = "pjkeladocehklaefmnhapmmpabmaeajd";

/** ID расширения Chrome из base64 `key` манифеста (алгоритм Chrome для распакованных расширений). */
export function extIdFromManifestKey(keyB64: string): string {
  const hex = createHash("sha256").update(Buffer.from(keyB64, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
}

/** Какой ID пиннить: явное переопределение (env) или ID нашего ключа. Пустое/пробелы = не задано. */
export function pinnedExtIdOrDefault(override?: string): string {
  const v = (override ?? "").trim().toLowerCase();
  return v || JARVIS_WEB_HANDS_EXT_ID;
}
