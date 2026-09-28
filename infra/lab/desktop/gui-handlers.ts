/** ЗАГЛУШКА: строитель заменяет содержимое (см. docs/lab/LAB.md, раздел «FakeDesktop»). Сигнатура фиксирована index.ts. */
import type { DesktopCore, KindHandler, KindHandlers } from "./core.js";

export function guiHandlers(_core: DesktopCore, _dispatch: KindHandler): KindHandlers {
  return {};
}
