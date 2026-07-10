/**
 * OBS Studio через obs-websocket v5 (§): ПРОГРАММНОЕ управление вместо хрупких кликов по меню.
 * OBS встроил WebSocket-сервер (Инструменты → Настройки WebSocket-сервера, порт 4455). Один вызов
 * = один запрос с контрактом (result/error) + возможность ПРОЧИТАТЬ состояние обратно (дешёвая
 * верификация без скриншота). Без сторонних либ: ws (уже в deps) + node:crypto.
 *
 * Конфиг: env OBS_WEBSOCKET_HOST (деф 127.0.0.1), OBS_WEBSOCKET_PORT (деф 4455),
 * OBS_WEBSOCKET_PASSWORD (если в OBS включена аутентификация).
 */
import WebSocket from "ws";
import { createHash } from "node:crypto";
import { createLogger } from "@jarvis/shared";

const log = createLogger("actuator:obs");
const DEFAULT_PORT = 4455;
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Строка аутентификации obs-websocket v5 (чистая функция — юнит-тестируется):
 *   base64( sha256( base64( sha256( password + salt ) ) + challenge ) )
 */
export function obsAuthSecret(password: string, salt: string, challenge: string): string {
  const b1 = createHash("sha256").update(password + salt).digest("base64");
  return createHash("sha256").update(b1 + challenge).digest("base64");
}

interface ObsMessage {
  op: number;
  d: Record<string, unknown>;
}
interface ObsAuth {
  challenge: string;
  salt: string;
}

/** Выполнить ОДИН запрос obs-websocket и вернуть responseData. Открывает соединение на запрос. */
export function request(requestType: string, requestData?: Record<string, unknown>): Promise<unknown> {
  const host = process.env.OBS_WEBSOCKET_HOST || "127.0.0.1";
  const port = Number.parseInt(process.env.OBS_WEBSOCKET_PORT || "", 10) || DEFAULT_PORT;
  const password = process.env.OBS_WEBSOCKET_PASSWORD || "";
  const url = `ws://${host}:${port}`;
  const requestId = `jarvis-${Date.now()}`;

  return new Promise<unknown>((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (err: Error | null, data?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* уже закрыт */
      }
      if (err) reject(err);
      else resolve(data);
    };
    const timer = setTimeout(
      () => finish(new Error(`OBS не ответил за ${CONNECT_TIMEOUT_MS / 1000}с — запущен ли OBS и включён ли WebSocket-сервер на порту ${port}?`)),
      CONNECT_TIMEOUT_MS,
    );

    ws.on("error", (e) => finish(e instanceof Error ? e : new Error(String(e))));
    ws.on("message", (raw: WebSocket.RawData) => {
      let msg: ObsMessage;
      try {
        msg = JSON.parse(raw.toString()) as ObsMessage;
      } catch {
        return;
      }
      if (msg.op === 0) {
        // Hello → Identify. Поле authentication присутствует, только если в OBS включён пароль.
        const rpcVersion = typeof msg.d.rpcVersion === "number" ? msg.d.rpcVersion : 1;
        const d: Record<string, unknown> = { rpcVersion, eventSubscriptions: 0 };
        const auth = msg.d.authentication as ObsAuth | undefined;
        if (auth?.challenge && auth?.salt) {
          if (!password) {
            finish(new Error("OBS требует пароль obs-websocket, но OBS_WEBSOCKET_PASSWORD не задан (в Настройках)."));
            return;
          }
          d.authentication = obsAuthSecret(password, auth.salt, auth.challenge);
        }
        ws.send(JSON.stringify({ op: 1, d }));
      } else if (msg.op === 2) {
        // Identified → шлём сам запрос.
        ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData: requestData ?? {} } }));
      } else if (msg.op === 7) {
        // RequestResponse — наш ли это ответ?
        if (msg.d.requestId !== requestId) return;
        const status = msg.d.requestStatus as { result?: boolean; code?: number; comment?: string } | undefined;
        if (status?.result) {
          log.info("obs.request ok", { requestType });
          finish(null, { requestType, responseData: msg.d.responseData ?? {} });
        } else {
          finish(new Error(`OBS отклонил ${requestType}: code=${status?.code ?? "?"} ${status?.comment ?? ""}`));
        }
      }
    });
  });
}
