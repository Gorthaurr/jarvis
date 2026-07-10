/**
 * Клиентская отправка сообщений userbot'ом (§12).
 *
 * Сервер уже прогнал гарды §14 (confirm + cadence + idempotency) и прислал
 * message.send. Здесь — фактическая доставка через @jarvis/userbots от аккаунта
 * пользователя; сессия/токены берутся из Electron safeStorage (DPAPI, §12).
 *
 * В dev без сессий используется MockSender (ничего наружу не уходит). Реальная
 * инициализация TelegramSender(StringSession)/VkSender(token) — при настроенных кредах.
 */
import type { MessageChannel } from "@jarvis/protocol";
import { MockSender, SenderRegistry, TelegramSender, VkSender, type ISender } from "@jarvis/userbots";
import { createLogger } from "@jarvis/shared";

const log = createLogger("actuator:messaging");

const registry = new SenderRegistry();

/** Инициализация отправителей из кред (вызывается при наличии сессий, §12). */
export function configureSenders(creds: { telegramSession?: string; vkToken?: string }): void {
  const tg: ISender = creds.telegramSession ? new TelegramSender(creds.telegramSession) : new MockSender("telegram");
  const vk: ISender = creds.vkToken ? new VkSender(creds.vkToken) : new MockSender("vk");
  registry.register(tg);
  registry.register(vk);
  log.info("отправители сконфигурированы", { telegram: tg.ready, vk: vk.ready });
}

/** Гарантировать наличие отправителей (dev → Mock). */
function ensure(channel: MessageChannel): ISender {
  let s = registry.get(channel);
  if (!s) {
    s = new MockSender(channel);
    registry.register(s);
  }
  return s;
}

/** Отправить сообщение (после серверных гардов §14). */
export async function sendMessage(channel: MessageChannel, to: string, body: string): Promise<{ messageId?: string }> {
  const sender = ensure(channel);
  // FAIL-CLOSED: если канал не подключён реальными кредами (доступен только Mock, ready=false),
  // НЕ рапортуем успех — иначе Джарвис скажет «отправлено», а наружу ничего не ушло (потеря
  // действия от лица пользователя + обман доверия). Mock-успех — только под явным dev-флагом.
  if (!sender.ready && process.env.JARVIS_ALLOW_MOCK_SEND !== "1") {
    throw new Error(`канал ${channel} не подключён — отправить не могу (нет сессии/кредов)`);
  }
  const res = await sender.send({ channel, recipient: to, body });
  if (!res.ok) throw new Error(res.error ?? "ошибка отправки userbot");
  log.info("сообщение отправлено", { channel, to, mock: !sender.ready });
  return { messageId: res.messageId };
}
