/**
 * message.send / order.place FakeDesktop. Наружу НИЧЕГО не уходит: отправка = запись в журнал эффектов (по нему сценарий
 * проверяет, что реально «ушло»). Правила клиента сохранены: канал без живой сессии — fail-closed (messaging.ts),
 * заказ с карточными данными — красная линия §0, а order.place по умолчанию отвечает так же, как настоящий клиент
 * (browser.ts: «не реализован (M7)») — лаборатория не должна доказывать возможность, которой у Джарвиса нет.
 */
import type { ActionCommand } from "@jarvis/protocol";
import type { DesktopCore, KindHandlers } from "./core.js";
import type { ServiceOptions } from "./service-options.js";
import { redact, runState, str } from "./service-state.js";

/** Красная линия карты (§0) — то же условие, что в actuators/browser.ts placeOrder. */
const cardLike = (blob: string): boolean => /\b\d{13,19}\b/u.test(blob.replace(/[\s-]/gu, "")) || /\b(cvv|cvc|pan|card_?number)\b/iu.test(blob);

export function messagingHandlers(core: DesktopCore, opts: () => ServiceOptions): KindHandlers {
  const st = (): { seq: number } => runState(core, "messaging", () => ({ seq: 0 }));

  return {
    "message.send": (cmd, meta) => {
      const c = cmd as Extract<ActionCommand, { kind: "message.send" }>;
      if (!opts().connectedChannels.includes(c.channel)) return core.fail(meta.commandId, "runtime", `канал ${c.channel} не подключён — отправить не могу (нет сессии/кредов)`);
      if (!str(c.to).trim() || !str(c.body).trim()) return core.fail(meta.commandId, "runtime", "ошибка отправки userbot: пустой получатель или текст");
      const messageId = `lab-${c.channel}-${++st().seq}`;
      core.effect("message.send", { channel: c.channel, to: c.to, body: c.body, messageId });
      return core.ok(meta.commandId, { messageId });
    },

    "order.place": (cmd, meta) => {
      const c = cmd as Extract<ActionCommand, { kind: "order.place" }>;
      if (cardLike(JSON.stringify(c))) return core.fail(meta.commandId, "runtime", "красная линия карты (§0): заказ содержит платёжные данные — отказ");
      if (opts().orderMode === "unimplemented") {
        core.effect("order.attempt", { vendor: c.vendor, total: c.total, items: c.items.length, placed: false });
        return core.fail(meta.commandId, "runtime", "order.place не реализован (M7): реальная сборка корзины/чекаут ещё не сделаны");
      }
      const orderId = `lab-order-${++st().seq}`;
      core.effect("order.place", { vendor: c.vendor, total: c.total, items: redact(c.items), orderId, money: 0 }); // запись без денег
      return core.ok(meta.commandId, { orderId });
    },
  };
}
