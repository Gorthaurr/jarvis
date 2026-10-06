/**
 * G1 · честность при молчащем клиенте (закон 1). Канал лёг → «не отправлено, жду» с флагом channelDown (не провал модели);
 * команда зависла (timeout) для ЧТЕНИЯ — просто ошибка, а для МУТАЦИИ исход неизвестен: клиент мог исполнить её позже,
 * значит «не удалось» — ложь, нужно uncertain.
 */
import type { ToolCase } from "../case-format.js";
import { silentClient } from "./g1-fixtures.js";

const down = (tool: string, args: Record<string, unknown>, extra: Partial<ToolCase["expect"]> = {}): ToolCase => ({
  tool,
  name: "канал с ПК лёг: «не отправлено, жду восстановления» + channelDown, а не «не получилось» и не «готово»",
  args,
  lab: silentClient("channel_down"),
  expect: { ok: false, flags: { channelDown: true }, resultExcludes: [/запущен|закрыт|сфокусирован|"closed"|"focused"/i], ...extra },
  coversTool: tool,
});

/** Мутация без ответа клиента: исход НЕИЗВЕСТЕН → uncertain (закон 1), а не «не удалось». */
const hung = (tool: string, args: Record<string, unknown>): ToolCase => ({
  tool,
  name: "клиент завис (timeout) на изменяющей команде: исход неизвестен — нужен uncertain, а не «не удалось»",
  args,
  lab: silentClient("timeout"),
  skip: "ДЕФЕКТ: dispatch.ts:873 — код timeout уходит в err(`Действие … не удалось: timeout`) без uncertain для мутаций (app.launch/app.close/window.focus/window.arrange…); клиент при таймауте НЕ отменяет исполнение (transport/index.ts Promise.race) → приложение может запуститься/закрыться позже, а модель услышит «не удалось» и повторит",
  expect: { ok: false, flags: { uncertain: true }, resultExcludes: /не удалось/ },
  coversTool: tool,
});

export const cases: ToolCase[] = [
  down("app_launch", { app: "notepad" }, { resultIncludes: "Не провал — жду восстановления" }),
  down("app_close", { app: "notepad" }, { resultIncludes: "Не провал — жду восстановления" }),
  down("app_focus", { app: "notepad" }),
  down("window_focus", { query: "Word" }),
  down("window_arrange", { op: "minimize", query: "Word" }),
  down("window_list", {}),
  down("screen_read_text", {}),
  down("screen_capture", {}, { resultIncludes: "screen_capture не снят: канал с ПК недоступен" }),
  down("screen_selection", { op: "view" }, { resultIncludes: "screen_selection не выполнен: канал с ПК недоступен" }),
  {
    tool: "screen_capture",
    name: "клиент завис (timeout) на чтении: честная ошибка «Не удалось снять экран», картинка не выдумана",
    lab: silentClient("timeout"),
    expect: { ok: false, resultIncludes: /Не удалось снять экран: timeout/, flags: { uncertain: false, channelDown: false } },
    coversTool: "screen_capture",
  },
  hung("app_launch", { app: "notepad" }),
  hung("app_close", { app: "notepad" }),
  hung("window_arrange", { op: "minimize", query: "Word" }),
];
