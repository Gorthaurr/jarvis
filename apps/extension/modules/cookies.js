/**
 * Выгрузка cookies (§ перенос логинов в невидимый браузер Джарвиса) — вынесено из god-file
 * background.js (§ревью split). Self-contained (только chrome.cookies). Требует право cookies (есть в манифесте).
 */

/**
 * Выгрузить куки твоего залогиненного Chrome для переноса логинов в невидимый браузер Джарвиса.
 * chrome.cookies отдаёт значения РАСШИФРОВАННЫМИ (минуя app-bound encryption Chrome 127+) — поэтому это
 * единственный рабочий путь (копирование файлов профиля ABE не расшифровать). domains=null → все хосты.
 */
export async function cookiesExport(domains) {
  if (!chrome.cookies || !chrome.cookies.getAll) {
    throw new Error("нет права cookies — переподтверди разрешения расширения в chrome://extensions");
  }
  const all = await chrome.cookies.getAll({});
  const cookies = all
    .filter((c) => !domains || domains.length === 0 || domains.some((d) => (c.domain || "").includes(String(d))))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite, // no_restriction|lax|strict|unspecified
      session: !!c.session,
      expirationDate: c.expirationDate, // unix sec (для persistent)
      hostOnly: !!c.hostOnly,
    }));
  return { ok: true, count: cookies.length, cookies };
}
