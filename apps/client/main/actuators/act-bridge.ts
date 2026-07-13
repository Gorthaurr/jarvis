/**
 * Локальный мост актуаторов (jarvis SDK, среда исполнения «1 раунд = вся задача»).
 *
 * ЗАЧЕМ. Раньше многошаговая GUI/системная задача шла как N отдельных LLM-раундов (скриншот → клик →
 * снова скриншот). Мост даёт code_run-скрипту (питон, спавнится code-runner'ом ОТДЕЛЬНЫМ процессом)
 * прямой доступ к тем же актуаторам, что дёргает сервер — через loopback-HTTP. Модель пишет ОДИН скрипт
 * с `jarvis.*` (focus/press/click/wait_for/find/ocr…), который делает ВСЮ процедуру за один раунд.
 *
 * БЕЗОПАСНОСТЬ. Мост НЕ расширяет полномочия: code_run уже исполняет произвольный код на машине; вызов
 * актуатора через мост идёт через тот же `dispatch` с его гардами (USER_BUSY, fs self-guard, честный
 * провал). Дополнительно: bind ТОЛЬКО на 127.0.0.1 (loopback) + токен per-boot в заголовке (случайный,
 * отдаётся лишь в env спавнутого раннера) → чужой локальный процесс не дёрнет. Тело ≤ BODY_CAP.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";

const log = createLogger("actuator:act-bridge");

/** Потолок тела запроса (актуатор-команды маленькие; большой ввод — через fs). */
const BODY_CAP = 512 * 1024;

/**
 * ALLOWLIST разрешённых на мосту ActionCommand.kind (ревью jarvis SDK, HIGH security-guard-bypass).
 *
 * Мост НЕ должен быть вторым, НЕГЕЙТЁННЫМ входом в клиентский dispatch для привилегированных каналов.
 * Серверные §14-гарды (confirm-once/cadence/idempotency/card-red-line) и креды (Telegram StringSession/
 * VK-токен из safeStorage, залогиненный jarvis-browser) живут В СЕРВЕРНОМ пути ДО эмита команды —
 * клиентские хендлеры telegram.send/message.send/order.place/jbrowser.* исполняют БЕЗ них («гарды уже
 * пройдены на сервере»). Раз code_run-скрипт (в т.ч. под prompt-injection) может сырым POST дёрнуть мост,
 * пускаем сюда ТОЛЬКО механический GUI + восприятие, которые SDK реально нужны. Отправка сообщений/
 * заказы/креды/необратимое/секреты (message.send, telegram.*, order.place, jbrowser.*, code.run, fs.*,
 * office.*, system.*) обязаны идти штатным серверным tool-путём с §14-гейтом, а не через loopback-мост.
 */
export const BRIDGE_ALLOWED_KINDS: ReadonlySet<string> = new Set<string>([
  // запуск / окна (механический GUI)
  "app.launch",
  "app.focus",
  "app.close",
  "window.list",
  "window.focus",
  // ввод
  "input.type",
  "input.key",
  "input.click",
  "input.mouse",
  // UIA-действие / грундинг
  "ui.invoke",
  "ui.ground",
  "ui.snapshot",
  // восприятие (read-only)
  "screen.capture",
  "screen.ocr",
  "screen.probe",
  "context.read",
  "wait.for",
]);

/** Исполнитель команды — тот же dispatch актуаторов (внедряется, чтобы мост тестировался без Electron). */
export type DispatchFn = (commandId: string, cmd: ActionCommand) => Promise<ActionResult>;

export interface ActBridge {
  /** Порт loopback-сервера. */
  port: number;
  /** Токен доступа (заголовок X-Jarvis-Token) — отдаётся ТОЛЬКО в env раннера. */
  token: string;
  /** Остановить мост (graceful shutdown). */
  stop(): Promise<void>;
}

/**
 * Поднять loopback-мост актуаторов. dispatch внедряется (актуаторный dispatch клиента). Возвращает
 * {port, token, stop}. Жизненный цикл — на вызывающем (стартуем один раз на boot, гасим на выходе).
 */
export function startActBridge(dispatch: DispatchFn): Promise<ActBridge> {
  const token = randomUUID();
  let counter = 0;

  const server: Server = createServer((req, res) => {
    // Только POST /act; всё прочее — 404 (мост узкий, не общий API).
    if (req.method !== "POST" || req.url !== "/act") {
      res.writeHead(404).end();
      return;
    }
    // Токен-гейт (loopback + секрет): чужой локальный процесс без токена не дёрнет актуаторы.
    if (req.headers["x-jarvis-token"] !== token) {
      res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: { code: "denied", message: "bad token" } }));
      return;
    }
    let body = "";
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      if (tooBig) return;
      body += chunk.toString("utf8");
      if (body.length > BODY_CAP) {
        tooBig = true;
        res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: { code: "runtime", message: "body too large" } }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return;
      let cmd: ActionCommand;
      try {
        const parsed = JSON.parse(body || "{}") as { kind?: string };
        if (!parsed || typeof parsed.kind !== "string") throw new Error("missing kind");
        cmd = parsed as unknown as ActionCommand;
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: { code: "runtime", message: `bad request: ${e instanceof Error ? e.message : String(e)}` } }));
        return;
      }
      // Гейт возможностей моста: только механический GUI/восприятие. Привилегированные каналы (отправка/
      // заказы/креды/необратимое) — 403, обязаны идти серверным путём с §14-гардами (см. BRIDGE_ALLOWED_KINDS).
      if (!BRIDGE_ALLOWED_KINDS.has(cmd.kind)) {
        log.warn("act-bridge: kind вне allowlist отклонён", { kind: cmd.kind });
        res
          .writeHead(403, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: false, error: { code: "denied", message: `kind '${cmd.kind}' не разрешён на мосту SDK (только механический GUI/восприятие; отправка/заказы/креды — через серверный tool-путь с §14-гейтом)` } }));
        return;
      }
      const commandId = `bridge-${(counter += 1).toString(36)}`;
      // dispatch НЕ бросает наружу (любое исключение → error.runtime внутри), но защищаемся на всякий.
      void dispatch(commandId, cmd)
        .then((result) => {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        })
        .catch((e) => {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({ commandId, ok: false, error: { code: "runtime", message: e instanceof Error ? e.message : String(e) }, durationMs: 0 }),
          );
        });
    });
    req.on("error", () => {
      try {
        res.writeHead(400).end();
      } catch {
        /* соединение уже закрыто */
      }
    });
  });

  // Незаслушанный 'error' на сервере (порт занят/EACCES) уронил бы main — деградируем логом.
  server.on("error", (e) => log.warn("act-bridge сервер: ошибка", { error: e instanceof Error ? e.message : String(e) }));

  return new Promise<ActBridge>((resolve, reject) => {
    // port 0 → ОС выдаёт свободный; bind СТРОГО на loopback (не наружу).
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("act-bridge: не удалось получить порт"));
        return;
      }
      log.info("act-bridge поднят (loopback)", { port: addr.port });
      resolve({
        port: addr.port,
        token,
        stop: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
