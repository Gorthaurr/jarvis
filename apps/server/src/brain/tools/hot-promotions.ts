/**
 * ПРОМОУТ холодных инструментов в горячие ПО ФАКТУ УСТАНОВЛЕННОЙ ПРОГРАММЫ (причина №5
 * USER_SCENARIOS_2026-09-02: «ежедневные инструменты в COLD — лишний раунд tool_load на каждую
 * бытовую просьбу»).
 *
 * §15: горячий набор — кешируемый префикс, холодные — строка каталога + tool_load (лишний раунд на
 * КАЖДЫЙ вызов). obs_request у стримера и office_excel у бухгалтера — ежедневные, у остальных — мёртвый
 * груз в префиксе. Решает не хардкод и не догадка, а то, что клиент РЕАЛЬНО нашёл на машине
 * (`client.env.installed` → `matchChannels` → рецепт): OBS — по exe (obs64.exe из DisplayIcon), Word/Excel на
 * Click-to-Run — по URI-схеме ms-word/ms-excel (exe в реестре у них нет; стейл-схема после деинсталляции
 * даст лишнюю схему в префиксе — цена ошибки мала). Есть канал «OBS Studio» → obs_request горячий на этой
 * сессии; нет OBS — схема не занимает префикс, инструмент по-прежнему в каталоге.
 *
 * Стабильность кеша: набор считается ОДИН раз на задачу (снимок в runAgentLoop) и меняется только со
 * сменой окружения (client.env, TTL 6 ч) — одна перезапись префикса, как rolling-брейкпоинт. Две щели
 * (ревью): первые ходы после холодного старта клиента идут до прихода client.env (promoted пуст → одна
 * перезапись, когда придёт); провал PS-инвентаря на TTL-пересборке уносит каналы на 6 ч. Текст-драйвер
 * `_jarvis_cmd.mjs` client.env не шлёт — живой смоук промоута только Electron-клиентом (лог «client.env … channels»).
 * Ключи карты привязаны к именам рецептов тестом (переименование рецепта роняет тест, а не промоут молча).
 * Безусловно горячими (без детекта) стали telegram_read / fs_move / fs_mkdir / fs_delete /
 * system_power / system_lock — они не зависят от установленного (см. COLD_TOOL_NAMES в packages/tools).
 */

/** Имя приложения в рецепте канала (`brain/app-channels.ts`, поле `app`) → инструменты, которые греем. */
export const PROMOTION_BY_APP: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ["OBS Studio", ["obs_request"]],
  ["Microsoft Word", ["office_word"]],
  ["Microsoft Excel", ["office_excel"]],
]);

/** ЧИСТАЯ: по сматченным каналам сессии — множество имён холодных инструментов, которые на ней горячие. */
export function hotPromotionsFor(channels: ReadonlyArray<{ app: string }> | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const c of channels ?? []) {
    for (const tool of PROMOTION_BY_APP.get(c.app) ?? []) out.add(tool);
  }
  return out;
}
