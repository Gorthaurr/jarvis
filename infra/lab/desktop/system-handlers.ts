/**
 * FakeDesktop — системная половина: файлы (fs.*), система (lock/power/media/volume/clipboard/layout) и звук приложений
 * (audio.*). Сборка таблиц; логика — в system-fs*.ts / system-sys.ts / system-audio.ts над виртуальной ФС (vfs*.ts).
 */
import type { DesktopCore, KindHandler, KindHandlers } from "./core.js";
import { audioHandlers } from "./system-audio.js";
import { fsHandlers } from "./system-fs.js";
import { sysHandlers } from "./system-sys.js";

export function systemHandlers(core: DesktopCore, _dispatch: KindHandler): KindHandlers {
  return { ...fsHandlers(core), ...sysHandlers(core), ...audioHandlers(core) };
}
