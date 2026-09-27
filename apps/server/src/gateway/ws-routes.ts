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
 * ПРАВИЛО. Клиенты /ws Origin не шлют вовсе: Electron-main и текст-драйвер ходят через npm-пакет `ws`
 * (Node не проставляет Origin). Расширение Chrome представляется `chrome-extension://<id>` ВСЕГДА.
 * Значит: непустой Origin на /ws → отказ; на /ext — только наш ID (S-12: пустой Origin = не Chrome →
 * отказ; пиннинг по умолчанию = ID из `key` манифеста, ext-id.ts), и живое расширение не вытесняется
 * (ext-liveness.ts). Гард срабатывает ДО onClient/attach — соединение не создаёт сессию.
 *
 * ⚠️ Маршруты вынесены из server.ts сюда НЕ ради красоты: гард обязан проверяться ПОВЕДЕНИЕМ
 * (правило аудита тестовой базы 2026-09-01), а для этого его нужно поднимать настоящим fastify
 * в тесте. Инлайн в boot-функции сервера он был бы покрыт только грепом по исходнику.
 */
import type { FastifyInstance } from "fastify";
import type { Logger } from "@jarvis/shared";
import { pinnedExtIdOrDefault } from "./ext-id.js";
import { ExtAdmission } from "./ext-liveness.js";

/** Минимальный контракт «сырого» ws-сокета (зеркало RawWs в server.ts). */
export interface RawWsLike {
  readonly readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping?(): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close" | "pong", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

/** Контракт моста расширения, нужный маршруту /ext. */
export interface ExtBridgeLike {
  attach(sock: { send(d: string): void; close(): void }): void;
  detach(sock: { send(d: string): void; close(): void }): void;
  handleMessage(text: string): void;
  /** Наше расширение (chrome-extension://) отклонено пиннингом по ID — для доклада владельцу (ext-absence). */
  rejected?(extId: string): void;
}

export interface WsRouteDeps {
  /** Клиентское соединение прошло гард — отдать его в handshake сервера. */
  onClient(socket: RawWsLike): void;
  ext: ExtBridgeLike;
  /** Нормализация входящего кадра в текст (у server.ts своя реализация). */
  rawToText(raw: unknown): string;
  log: Logger;
  /** Переопределение ID расширения на /ext (env JARVIS_EXT_ID). Пусто = ID из `key` манифеста (S-12). */
  pinnedExtId?: string;
  /** Тесты: таймаут ping живого расширения (по умолчанию 1,5 с). */
  extPingTimeoutMs?: number;
}

/** Канал: клиентский (/ws) или расширение (/ext). У них РАЗНЫЙ допустимый Origin. */
export type WsChannel = "client" | "ext";

/**
 * Допустимо ли происхождение соединения. /ws: пустой Origin = нативный клиент (Node/Electron/тесты) —
 * браузер обязан проставлять Origin, его отсутствие = «пришли не из страницы». /ext: Chrome ВСЕГДА шлёт
 * `chrome-extension://<id>`, поэтому пустой Origin там — чужой процесс (S-12), а не расширение.
 */
export function isAllowedWsOrigin(rawOrigin: unknown, channel: WsChannel, pinnedExtId?: string): boolean {
  const origin = String(rawOrigin ?? "").trim().toLowerCase();
  if (channel === "ext") {
    // Канал отдаёт cookies.export (все куки расшифрованными) и telegram.send — пускаем ТОЛЬКО наш ID.
    return origin === `chrome-extension://${pinnedExtIdOrDefault(pinnedExtId)}`;
  }
  if (origin === "") return true;
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
  const admission = new ExtAdmission(deps.log, deps.extPingTimeoutMs);
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
    if (!isAllowedWsOrigin(origin, "ext", deps.pinnedExtId)) {
      if (/^chrome-extension:\/\//iu.test(origin)) {
        // Чаще всего это НАШЕ расширение с другим ID (распакованное загружено из другой папки). Молча отказать =
        // «руки в браузере мертвы, а почему — не видно» (24.09 так пролежали сутки). Говорим, что сделать.
        deps.log.warn("/ext: расширение отклонено пиннингом — если это Jarvis Web Hands, обновите JARVIS_EXT_ID", {
          пришло: origin.replace(/^chrome-extension:\/\//iu, ""),
          ожидается: pinnedExtIdOrDefault(deps.pinnedExtId),
        });
        deps.ext.rejected?.(origin.replace(/^chrome-extension:\/\//iu, "").toLowerCase());
      }
      refuse(ws, deps.log, "ext", origin);
      return;
    }
    // S-12: живое расширение не вытесняется; кадры слушаем только у допущенного (до допуска — ни одного).
    const sock = { send: (d: string) => ws.send(d), close: () => ws.close() };
    ws.on("error", () => deps.ext.detach(sock)); // сразу: необработанный 'error' до допуска уронил бы процесс
    void admission.admit(ws, () => {
      deps.ext.attach(sock);
      ws.on("message", (raw: unknown) => deps.ext.handleMessage(deps.rawToText(raw)));
      ws.on("close", () => deps.ext.detach(sock));
    });
  });
}
