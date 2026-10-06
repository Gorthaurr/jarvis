/**
 * FakeDesktop — GUI-половина: окна и приложения, UIA-дерево, ввод, gui.act (лестница + сверка + рубеж §14), зрение,
 * ожидание на виртуальных часах, мониторы. Собирается из модулей gui-*; состояние — только через DesktopCore
 * (окна, foreground, буфер, монитор) и `guiState` (кадры, вуаль, выделение). Сигнатура фиксирована index.ts.
 */
import type { DesktopCore, KindHandler, KindHandlers } from "./core.js";
import { ioHandlers } from "./gui-io.js";
import { screenHandlers } from "./gui-screen.js";
import { guiState } from "./gui-state.js";
import { uiaHandlers } from "./gui-uia.js";
import { windowHandlers } from "./gui-windows.js";

export function guiHandlers(core: DesktopCore, dispatch: KindHandler): KindHandlers {
  // Слушатель «внешних событий владельца» (user.selection, user.gsi, ...) подключаем сразу: userAction до первой GUI-команды не должен теряться.
  guiState(core);
  return { ...windowHandlers(core), ...uiaHandlers(core), ...ioHandlers(core, dispatch), ...screenHandlers(core, dispatch) };
}
