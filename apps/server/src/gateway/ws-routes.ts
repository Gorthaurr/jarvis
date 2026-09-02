/**
 * §sec: регистрация WS-маршрутов gateway + ГАРД ПРОИСХОЖДЕНИЯ (Origin).
 *
 * 🔴 КОРЕНЬ (разведка ландшафта 2026-09-01; класс CVE-2026-25253 у OpenClaw, CVSS 8.8 —
 * Cross-Site WebSocket Hijacking): браузер НЕ применяет CORS к WebSocket. Любая страница,
 * открытая владельцем (годится и рекламный iframe), могла выполнить
 * `new WebSocket("ws://127.0.0.1:8787/ws")`, представиться `client.hello` с общеизвестным
 * 'dev-token' (на loopback это КЛЮЧ ПАРТИЦИИ, а не секрет — так и записано в карте) и получить
 * ПОЛНЫЙ канал управления машиной: кадр `dev.text` уходит прямо в петлю агента (а там code_run,
 * fs_*, app_launch, input_*), а `user.confirm.result` позволяет странице САМОЙ подтвердить
 * §14-гейт — то есть обойти единственное место, где решение принимает человек.
 * Привязка к loopback от этого не защищает: у OpenClaw она не защитила (40 214 инстансов).
 * Гард на /ext стоит с ревью H13, а на клиентском /ws его не было НИКОГДА.
 *
 * ПРАВИЛО. Легальные клиенты Origin не шлют вовсе: Electron-main и текст-драйвер ходят через
 * npm-пакет `ws` (Node не проставляет Origin), расширение представляется `chrome-extension://`.
 * Значит: непустой Origin на /ws → отказ; на /ext → допускается только `chrome-extension://`.
 * Гард срабатывает ДО onClient/attach — соединение не доживает до handshake и не создаёт сессию.
 *
 * ⚠️ Маршруты вынесены из server.ts сюда НЕ ради красоты: гард обязан проверяться ПОВЕДЕНИЕМ
 * (правило аудита тестовой базы 2026-09-01), а для этого его нужно поднимать настоящим fastify
 * в тесте. Инлайн в boot-функции сервера он был бы покрыт только грепом по исходнику.
 */
import type { FastifyInstance } from "fastify";
import type { Logger } from "@jarvis/shared";

/** Минимальный контракт «сырого» ws-сокета (зеркало RawWs в server.ts). */
export interface RawWsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

/** Контракт моста расширения, нужный маршруту /ext. */
export interface ExtBridgeLike {
  attach(sock: { send(d: string): void; close(): void }): void;
  detach(sock: { send(d: string): void; close(): void }): void;
  handleMessage(text: string): void;
}

export interface WsRouteDeps {
  /** Клиентское соединение прошло гард — отдать его в handshake сервера. */
  onClient(socket: RawWsLike): void;
  ext: ExtBridgeLike;
  /** Нормализация входящего кадра в текст (у server.ts своя реализация). */
  rawToText(raw: unknown): string;
  log: Logger;
}

/** Канал: клиентский (/ws) или расширение (/ext). У них РАЗНЫЙ допустимый Origin. */
export type WsChannel = "client" | "ext";

/**
 * Допустимо ли происхождение соединения. Пустой Origin = нативный клиент (Node/Electron/тесты):
 * браузер обязан проставлять Origin, поэтому его отсутствие означает «пришли не из страницы».
 */
export function isAllowedWsOrigin(rawOrigin: unknown, channel: WsChannel): boolean {
  const origin = String(rawOrigin ?? "").trim().toLowerCase();
  if (origin === "") return true;
  if (channel === "ext") return origin.startsWith("chrome-extension://");
  // Клиентскому каналу браузерное происхождение не нужно ни в каком виде — в том числе
  // chrome-extension:// (у расширения свой канал /ext со своим протоколом).
  return false;
}

/** Origin из заголовков запроса (fastify отдаёт их в нижнем регистре). */
function originOf(request: unknown): string {
  const headers = (request as { headers?: Record<string, unknown> } | undefined)?.headers;
  return String(headers?.origin ?? "");
}

function refuse(ws: RawWsLike, log: Logger, channel: WsChannel, origin: string): void {
  log.warn("§sec: WS-соединение отклонено по Origin (Cross-Site WebSocket Hijacking)", { channel, origin });
  try {
    ws.close();
  } catch {
    /* уже закрыт */
  }
}

/** Зарегистрировать /ws (клиент) и /ext (расширение Chrome) с гардом происхождения. */
export function registerWsRoutes(instance: FastifyInstance, deps: WsRouteDeps): void {
  instance.get("/ws", { websocket: true }, (connection: unknown, request: unknown) => {
    // @fastify/websocket v11: первый аргумент — это сам WebSocket (ws.WebSocket).
    const socket = connection as RawWsLike;
    const origin = originOf(request);
    if (!isAllowedWsOrigin(origin, "client")) {
      refuse(socket, deps.log, "client", origin);
      return;
    }
    deps.onClient(socket);
  });

  // Канал расширения (Chrome). Своя WS, отдельно от клиентского /ws (другой протокол).
  instance.get("/ext", { websocket: true }, (connection: unknown, request: unknown) => {
    const ws = connection as RawWsLike;
    const origin = originOf(request);
    if (!isAllowedWsOrigin(origin, "ext")) {
      refuse(ws, deps.log, "ext", origin);
      return;
    }
    const sock = { send: (d: string) => ws.send(d), close: () => ws.close() };
    deps.ext.attach(sock);
    ws.on("message", (raw: unknown) => deps.ext.handleMessage(deps.rawToText(raw)));
    ws.on("close", () => deps.ext.detach(sock));
    ws.on("error", () => deps.ext.detach(sock));
  });
}
