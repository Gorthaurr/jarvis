/**
 * @jarvis/userbots — отправка сообщений от лица пользователя (§12).
 *
 * Действуют от АККАУНТА пользователя: Telegram (GramJS), VK (vk-io). Сессия/ключи
 * живут на КЛИЕНТЕ (StringSession в Electron safeStorage/DPAPI, §12) и не покидают
 * машину. Сам `send` идёт через клиентский userbot ПОСЛЕ подтверждения и гардов §14.
 *
 * Контракт ISender абстрагирует канал. Реальные адаптеры импортируют SDK динамически
 * (отсутствие пакета/сессии → ошибка, не падение импорта). MockSender — для тестов/дев.
 *
 * Поведенческий риск (§12): анти-абуз ловит спам-сигнатуру (объём/веер/burst/одинаковый
 * текст). Её гасит cadence guard на сервере (§14), а не отказ от автоматизации.
 */
import type { MessageChannel } from "@jarvis/protocol";

export interface SendRequest {
  channel: MessageChannel;
  /** Резолвнутый адрес в канале (id/username/peer). */
  recipient: string;
  body: string;
}

export interface SendResult {
  ok: boolean;
  /** id отправленного сообщения в канале (если успех). */
  messageId?: string;
  error?: string;
}

export interface ISender {
  readonly channel: MessageChannel;
  /** Готов ли (есть сессия/SDK). */
  readonly ready: boolean;
  send(req: SendRequest): Promise<SendResult>;
}

/** Mock-отправитель: ничего не шлёт наружу, фиксирует вызовы (тесты/дев). */
export class MockSender implements ISender {
  readonly ready = true;
  readonly sent: SendRequest[] = [];
  constructor(readonly channel: MessageChannel = "telegram") {}
  async send(req: SendRequest): Promise<SendResult> {
    this.sent.push(req);
    return { ok: true, messageId: `mock-${this.sent.length}` };
  }
}

/**
 * Telegram userbot (GramJS). Сессия (StringSession) приходит с клиента. SDK
 * импортируется динамически; без него ready=false.
 * // TODO(M6): полная инициализация TelegramClient(StringSession) + sendMessage.
 */
export class TelegramSender implements ISender {
  readonly channel = "telegram" as const;
  ready = false;
  constructor(private readonly stringSession?: string) {
    this.ready = Boolean(stringSession);
  }
  async send(req: SendRequest): Promise<SendResult> {
    if (!this.ready) return { ok: false, error: "telegram-сессия не сконфигурирована" };
    try {
      const spec = "telegram";
      const mod = (await import(spec).catch(() => null)) as unknown;
      if (!mod) return { ok: false, error: "пакет telegram (GramJS) не установлен" };
      // TODO(M6): new TelegramClient(new StringSession(this.stringSession), apiId, apiHash)
      //   → client.sendMessage(req.recipient, { message: req.body }).
      return { ok: false, error: "GramJS send — TODO(M6)" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/**
 * VK userbot (vk-io) с user-токеном. VK строже к автоматизации (§12) — предпочтителен
 * официальный API/десктоп-клиент через грундинг; здесь — user-token путь.
 * // TODO(M6): VK({token}).api.messages.send(...).
 */
export class VkSender implements ISender {
  readonly channel = "vk" as const;
  ready = false;
  constructor(private readonly token?: string) {
    this.ready = Boolean(token);
  }
  async send(req: SendRequest): Promise<SendResult> {
    if (!this.ready) return { ok: false, error: "vk-токен не сконфигурирован" };
    try {
      const spec = "vk-io";
      const mod = (await import(spec).catch(() => null)) as unknown;
      if (!mod) return { ok: false, error: "пакет vk-io не установлен" };
      // TODO(M6): new VK({ token }).api.messages.send({ peer_id, message, random_id }).
      void req;
      return { ok: false, error: "vk-io send — TODO(M6)" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** Набор отправителей по каналам (на клиенте). */
export class SenderRegistry {
  private readonly map = new Map<MessageChannel, ISender>();
  register(sender: ISender): void {
    this.map.set(sender.channel, sender);
  }
  get(channel: MessageChannel): ISender | undefined {
    return this.map.get(channel);
  }
}
