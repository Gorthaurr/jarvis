/**
 * FakeDesktop — сервисная группа: code.run/job.status, skill.execute, office.excel/word, obs.request, message.send,
 * telegram.send/read, order.place, jbrowser.*. Сборка модулей service-*.ts; сигнатура фиксирована index.ts, третий
 * аргумент (опции) необязателен — без него действуют глобальные `setServiceOptions` (читаются в момент вызова).
 * Ничего наружу не уходит: исходящее пишется в журнал эффектов, code.run по умолчанию выключен.
 */
import type { DesktopCore, KindHandler, KindHandlers } from "./core.js";
import { codeHandlers } from "./service-code.js";
import { jbrowserHandlers } from "./service-jbrowser.js";
import { messagingHandlers } from "./service-messaging.js";
import { obsHandlers } from "./service-obs.js";
import { officeHandlers } from "./service-office.js";
import { type ServiceOptions, getServiceOptions } from "./service-options.js";
import { skillHandlers } from "./service-skill.js";
import { telegramHandlers } from "./service-telegram.js";

export { getServiceOptions, resetServiceOptions, setServiceOptions } from "./service-options.js";
export type { ServiceOptions, TgChatSeed } from "./service-options.js";
export type { CodeExecutor, CodeOutcome, CodeRequest } from "./service-code-exec.js";
export { readOfficeDoc } from "./service-office.js";

export function serviceHandlers(core: DesktopCore, dispatch: KindHandler, options?: Partial<ServiceOptions>): KindHandlers {
  const opts = (): ServiceOptions => (options ? { ...getServiceOptions(), ...options } : { ...getServiceOptions() });
  return {
    ...codeHandlers(core, opts),
    ...skillHandlers(core, dispatch, opts),
    ...officeHandlers(core),
    ...obsHandlers(core, opts),
    ...messagingHandlers(core, opts),
    ...telegramHandlers(core, opts),
    ...jbrowserHandlers(core),
  };
}
